// Read-ahead for the songs being played.
//
// WebKit on macOS does not buffer a song. AVFoundation asks for it a few
// seconds at a time through the homelab:// scheme and keeps about four seconds
// queued. Every one of those requests had to reach home and come back within
// those four seconds, for the whole length of the song. One that failed was
// treated as the end of the song. On 2026-11-25 Caddy on pi-server restarted
// for twelve seconds, and a six-minute FLAC stopped at 3:22.
//
// So audio is no longer fetched one request at a time. The first request for
// a song starts one download of the whole file into a temporary file, at
// whatever speed the path allows. Every range the player asks for is answered
// from that file. A dropped connection or a restart at home is retried from
// the byte it stopped at, and the player never sees it. The player only waits
// when it has caught up with the download. Anything the read-ahead cannot
// answer goes straight to home as before, so that home's own answer (a 404,
// a 416, the archive being asleep) still reaches the player.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use http::HeaderValue;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{watch, RwLock};

use crate::proxy::{Proxy, RANGE_CHUNK};

/// The one path the read-ahead answers.
pub const STREAM_PATH: &str = "/api/player/stream";

/// Songs kept on disk: the one playing, the one buffered next, and the one
/// before, for Previous. Older files are deleted.
const KEEP: usize = 3;

/// Downloads that run at once: the songs asked for most recently, which are
/// the one playing and the one buffered next. An older one stops where it is,
/// so a skipped song does not share the connection with the one playing, and
/// carries on from there if the player asks for it again.
const RUNNING: usize = 2;

/// How far past the download a request may start and still wait for it. A
/// seek further ahead than this goes straight to home rather than waiting
/// for the download to get there, which over the tunnel could take a while.
const FAR_AHEAD: u64 = 2 * RANGE_CHUNK;

/// An open-ended request is answered as soon as this much is in, rather than
/// waiting for a whole chunk, so a song starts promptly on a slow path.
const MIN_ANSWER: u64 = 256 * 1024;

/// Bytes collected before each write to disk.
const WRITE_AT: usize = 256 * 1024;

/// Where audio comes from. Home in the app; a script in the tests.
pub trait Upstream: Send + Sync + 'static {
    /// `path` from byte `from` to the end.
    fn open(&self, path: &str, from: u64) -> BoxFuture<'static, Result<Opened, Failure>>;
}

/// The head of an answer, and its body still to read.
pub struct Opened {
    /// Where `body` starts: `from` for a 206, 0 for a 200.
    pub start: u64,
    /// The length of the whole file, if home said.
    pub total: Option<u64>,
    pub content_type: Option<HeaderValue>,
    /// Home's ETag, or failing that its Last-Modified.
    pub validator: Option<HeaderValue>,
    pub body: BoxStream<'static, Result<Vec<u8>>>,
}

pub enum Failure {
    /// Home answered, with this status and no audio.
    Status(u16),
    /// No answer at all: the connection, TLS, a timeout.
    Unreachable(anyhow::Error),
}

/// How patient the read-ahead is. Fixed in the app; shortened in the tests.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// No bytes for this long and a connection is taken for dead. Also how
    /// long a request waits on a download that is not moving.
    pub stall: Duration,
    /// A download that makes no progress for this long, retries included,
    /// is abandoned. The player's next request for the song starts it again.
    pub give_up: Duration,
    /// The first retry's delay; it doubles up to `retry_max`.
    pub retry: Duration,
    pub retry_max: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            stall: Duration::from_secs(15),
            give_up: Duration::from_secs(90),
            retry: Duration::from_millis(250),
            retry_max: Duration::from_secs(4),
        }
    }
}

pub struct Streams {
    upstream: Arc<dyn Upstream>,
    /// None if the directory could not be prepared; then nothing is cached
    /// and every request goes straight to home, as it did before this existed.
    dir: Option<PathBuf>,
    timing: Timing,
    /// Least recently asked for first.
    entries: Mutex<Vec<Arc<Entry>>>,
    next_id: AtomicU64,
}

struct Entry {
    key: String,
    file: PathBuf,
    progress: watch::Sender<Progress>,
    task: Mutex<Option<tokio::task::AbortHandle>>,
}

#[derive(Clone, Debug, Default)]
struct Progress {
    /// Bytes on disk, counted from the start of the file. All readable.
    have: u64,
    total: Option<u64>,
    content_type: Option<HeaderValue>,
    /// Home's ETag or Last-Modified for the file, to tell a resumed answer
    /// is still the same file.
    validator: Option<HeaderValue>,
    /// Bumped whenever the file on disk is thrown away and started again,
    /// so an answer read across a restart is never sent.
    generation: u64,
    state: State,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Running,
    Done,
    /// Given up on, stopped for newer songs, or retired. Requests go
    /// straight to home, and one for a song still kept starts it again.
    Failed,
}

/// A `Range: bytes=start-end` header. `end` is inclusive, None when open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Wanted {
    start: u64,
    end: Option<u64>,
}

impl Streams {
    /// `dir` is emptied first: anything in it is left over from a previous run.
    pub fn new(upstream: Arc<dyn Upstream>, dir: PathBuf, timing: Timing) -> Self {
        let dir = match prepare(&dir) {
            Ok(()) => Some(dir),
            Err(error) => {
                log::warn!("no read-ahead for audio, streaming directly: {error:#}");
                None
            }
        };
        Self {
            upstream,
            dir,
            timing,
            entries: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(0),
        }
    }

    /// Answer one audio range request from the read-ahead.
    ///
    /// None means "ask home directly": a range this cannot or should not
    /// answer, or a download that has failed. The caller then forwards the
    /// request exactly as it did before the read-ahead existed.
    pub async fn serve(&self, key: &str, range: &str) -> Option<http::Response<Vec<u8>>> {
        // No directory, no read-ahead.
        self.dir.as_ref()?;
        let wanted = parse_range(range)?;
        let entry = self.entry(key);
        let mut progress = entry.progress.subscribe();
        loop {
            let now = progress.borrow_and_update().clone();
            if now.state == State::Failed {
                return None;
            }
            if let Some(total) = now.total {
                // Past the end: home answers 416, and should.
                if wanted.start >= total {
                    return None;
                }
                let last = match wanted.end {
                    Some(end) => end.min(total - 1),
                    // WebView2 asks for everything from here on. One chunk
                    // at a time, the same as the proxy has always done.
                    None => (wanted.start + RANGE_CHUNK - 1).min(total - 1),
                };
                // The whole window; or less of it, when that is enough to
                // start on or all there will ever be.
                let enough = wanted.end.is_none() && now.have >= wanted.start + MIN_ANSWER;
                let ready = if now.have > last {
                    Some(last)
                } else if now.have > wanted.start && (enough || now.state == State::Done) {
                    Some(now.have - 1)
                } else {
                    None
                };
                if let Some(last) = ready {
                    return answer(&entry, &now, wanted.start, last, total).await;
                }
                if now.state == State::Done {
                    return None;
                }
            }
            if wanted.start > now.have + FAR_AHEAD {
                return None;
            }
            match tokio::time::timeout(self.timing.stall, progress.changed()).await {
                Ok(Ok(())) => continue,
                // Retired, or not moving: let home answer this one directly.
                Ok(Err(_)) | Err(_) => return None,
            }
        }
    }

    /// The entry for `key`, made and started if new. A failed one is started
    /// again, from where it stopped: the player asking is reason to try.
    fn entry(&self, key: &str) -> Arc<Entry> {
        let mut entries = self.entries.lock().expect("stream entries lock");
        if let Some(at) = entries.iter().position(|e| e.key == key) {
            let entry = entries.remove(at);
            entries.push(entry.clone());
            if entry.progress.borrow().state == State::Failed {
                self.start(&entry);
            }
            hold_back(&entries);
            return entry;
        }
        let dir = self.dir.as_ref().expect("serve checks the directory first");
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(Entry {
            key: key.to_owned(),
            file: dir.join(format!("{id}.audio")),
            progress: watch::channel(Progress::default()).0,
            task: Mutex::new(None),
        });
        entries.push(entry.clone());
        while entries.len() > KEEP {
            entries.remove(0).retire();
        }
        self.start(&entry);
        hold_back(&entries);
        entry
    }

    fn start(&self, entry: &Arc<Entry>) {
        entry.progress.send_modify(|p| p.state = State::Running);
        let task = tokio::spawn(download(self.upstream.clone(), entry.clone(), self.timing));
        if let Some(previous) = entry
            .task
            .lock()
            .expect("stream task lock")
            .replace(task.abort_handle())
        {
            previous.abort();
        }
    }
}

/// Stop every download but the newest RUNNING, keeping what they have.
fn hold_back(entries: &[Arc<Entry>]) {
    let older = entries.len().saturating_sub(RUNNING);
    for entry in &entries[..older] {
        entry.stop();
    }
}

impl Entry {
    /// Stop downloading and release anyone waiting. The file stays, and a
    /// later request carries on from the byte it reached.
    fn stop(&self) {
        if let Some(task) = self.task.lock().expect("stream task lock").take() {
            task.abort();
        }
        self.progress.send_if_modified(|p| {
            let running = p.state == State::Running;
            if running {
                p.state = State::Failed;
            }
            running
        });
    }

    /// Stop downloading, release anyone waiting, and delete the file.
    fn retire(&self) {
        if let Some(task) = self.task.lock().expect("stream task lock").take() {
            task.abort();
        }
        self.progress.send_modify(|p| p.state = State::Failed);
        // On Windows a reader may still have it open; the next launch clears it.
        let _ = std::fs::remove_file(&self.file);
    }
}

fn prepare(dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("clearing {}", dir.display())),
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))
}

/// Read `start..=last` back from disk as a 206.
///
/// None if the file was started again while it was being read: the bytes
/// could then belong to a different file than `progress` describes.
async fn answer(
    entry: &Entry,
    progress: &Progress,
    start: u64,
    last: u64,
    total: u64,
) -> Option<http::Response<Vec<u8>>> {
    let file = &entry.file;
    let read = async {
        let mut handle = tokio::fs::File::open(file).await?;
        handle.seek(SeekFrom::Start(start)).await?;
        let mut body = vec![0; usize::try_from(last - start + 1)?];
        handle.read_exact(&mut body).await?;
        anyhow::Ok(body)
    };
    let body = match read.await {
        Ok(body) => body,
        Err(error) => {
            log::warn!("read-ahead could not read {}: {error:#}", file.display());
            return None;
        }
    };
    if entry.progress.borrow().generation != progress.generation {
        return None;
    }
    let mut response = http::Response::builder()
        .status(206)
        .header("content-range", format!("bytes {start}-{last}/{total}"))
        .header("content-length", body.len())
        .header("accept-ranges", "bytes")
        .header("cache-control", "private, no-store")
        // Same as every proxied answer; see Proxy::forward.
        .header("access-control-allow-origin", "*");
    if let Some(kind) = &progress.content_type {
        response = response.header("content-type", kind.clone());
    }
    response.body(body).ok()
}

/// Fetch the whole file into `entry.file`, retrying from where it stopped.
async fn download(upstream: Arc<dyn Upstream>, entry: Arc<Entry>, timing: Timing) {
    let outcome = fetch(&*upstream, &entry, timing).await;
    if let Err(error) = &outcome {
        log::warn!("read-ahead for {} stopped: {error:#}", entry.key);
    }
    entry.progress.send_modify(|p| {
        p.state = if outcome.is_ok() {
            State::Done
        } else {
            State::Failed
        };
    });
}

async fn fetch(upstream: &dyn Upstream, entry: &Entry, timing: Timing) -> Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&entry.file)
        .await
        .with_context(|| format!("opening {}", entry.file.display()))?;
    // Picking up a download that stopped: keep what is already on disk.
    let mut have = entry.progress.borrow().have;
    file.set_len(have).await?;
    file.seek(SeekFrom::Start(have)).await?;

    let mut delay = timing.retry;
    let mut moved = Instant::now();
    // Whether any audio has arrived, in this download or the one it resumes.
    let mut flowed = have > 0;
    // The furthest the file has got. Only passing it counts as progress, so
    // a song that keeps starting again and dropping at the same point still
    // gives up.
    let mut furthest = have;
    loop {
        let opened = tokio::time::timeout(timing.stall, upstream.open(&entry.key, have)).await;
        let failure = match opened {
            Ok(Ok(opened)) => {
                let Some(total) = opened.total else {
                    // Nothing to answer a range with, now or on a retry.
                    bail!("home did not say how long the file is");
                };
                match receive(&mut file, entry, opened, total, &mut have, timing).await {
                    Ok(true) => return Ok(()),
                    Ok(false) => anyhow!("the connection closed at byte {have}"),
                    Err(error) if error.is::<Disk>() => return Err(error),
                    Err(error) => error,
                }
            }
            Ok(Err(Failure::Status(status))) => anyhow!("home answered {status}"),
            Ok(Err(Failure::Unreachable(error))) => error,
            Err(_) => anyhow!("no answer in {:?}", timing.stall),
        };
        if have < furthest {
            // Home replaced the song and the file started again from the
            // top. Progress is counted on the new file from here.
            furthest = have;
            moved = Instant::now();
            delay = timing.retry;
        }
        flowed |= have > 0;
        if !flowed {
            // Before any audio, home's answer is the answer: the player gets
            // it directly, the same as it did before the read-ahead.
            return Err(failure);
        }
        if have > furthest {
            furthest = have;
            moved = Instant::now();
            delay = timing.retry;
        }
        if moved.elapsed() >= timing.give_up {
            return Err(failure.context(format!("no progress in {:?}", timing.give_up)));
        }
        log::info!(
            "read-ahead for {}: {failure:#}; trying again from byte {have}",
            entry.key
        );
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(timing.retry_max);
    }
}

/// A failure of this machine's disk rather than the network. Retrying will
/// not fix it, so the download stops and home answers directly.
#[derive(Debug)]
struct Disk(std::io::Error);

impl std::fmt::Display for Disk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "writing the read-ahead: {}", self.0)
    }
}

impl std::error::Error for Disk {}

/// Write one answer's body to disk. True once the file is complete.
async fn receive(
    file: &mut tokio::fs::File,
    entry: &Entry,
    opened: Opened,
    total: u64,
    have: &mut u64,
    timing: Timing,
) -> Result<bool> {
    let Opened {
        start,
        content_type,
        validator,
        mut body,
        ..
    } = opened;
    // Bytes are only appended to what is on disk when this answer is shown
    // to be the same file. A different length, or a different ETag or
    // Last-Modified, means the song was replaced at home part-way through;
    // with no validator on either side there is no telling. Either way, start
    // again from the top rather than risk joining two files together.
    let resuming = *have > 0 && start == *have;
    let replaced = {
        let known = entry.progress.borrow();
        let length = known.total.is_some_and(|known| known != total);
        let version = match (&known.validator, &validator) {
            (Some(was), Some(now)) => was != now,
            _ => resuming,
        };
        length || version
    };
    if replaced {
        restart(file, entry, have).await?;
        if start != 0 {
            bail!("cannot tell that home still has the same file");
        }
    }
    if start != *have {
        if start != 0 {
            bail!("asked for byte {have}, home sent from byte {start}");
        }
        // A 200 instead of a 206: the whole file again, from the top.
        restart(file, entry, have).await?;
    }
    entry.progress.send_modify(|p| {
        p.have = *have;
        p.total = Some(total);
        if content_type.is_some() {
            p.content_type = content_type;
        }
        if validator.is_some() {
            p.validator = validator;
        }
    });

    let mut pending = Vec::with_capacity(WRITE_AT);
    loop {
        match tokio::time::timeout(timing.stall, body.next()).await {
            Ok(Some(Ok(chunk))) => {
                pending.extend_from_slice(&chunk);
                if pending.len() >= WRITE_AT {
                    write(file, entry, &mut pending, have).await?;
                }
            }
            Ok(None) => {
                write(file, entry, &mut pending, have).await?;
                return Ok(*have >= total);
            }
            Ok(Some(Err(error))) => {
                write(file, entry, &mut pending, have).await?;
                return Err(error);
            }
            Err(_) => {
                write(file, entry, &mut pending, have).await?;
                bail!("no data for {:?}", timing.stall);
            }
        }
    }
}

/// Put `pending` on disk, then tell any waiting request it is there.
async fn write(
    file: &mut tokio::fs::File,
    entry: &Entry,
    pending: &mut Vec<u8>,
    have: &mut u64,
) -> Result<()> {
    if pending.is_empty() {
        return Ok(());
    }
    file.write_all(pending).await.map_err(Disk)?;
    // tokio writes on a background thread; flush waits for it, so the bytes
    // are readable before anyone is told they are.
    file.flush().await.map_err(Disk)?;
    *have += pending.len() as u64;
    pending.clear();
    let have = *have;
    entry.progress.send_modify(|p| p.have = have);
    Ok(())
}

/// Throw away what is on disk and start the file from its first byte.
async fn restart(file: &mut tokio::fs::File, entry: &Entry, have: &mut u64) -> Result<()> {
    *have = 0;
    // Before the file is touched, so a read that overlaps it is discarded.
    entry.progress.send_modify(|p| {
        p.have = 0;
        p.total = None;
        p.validator = None;
        p.generation += 1;
    });
    file.set_len(0).await.map_err(Disk)?;
    file.seek(SeekFrom::Start(0)).await.map_err(Disk)?;
    Ok(())
}

fn parse_range(value: &str) -> Option<Wanted> {
    let spec = value.trim().strip_prefix("bytes=")?;
    // Multiple ranges answer as multipart/byteranges; home can do that.
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    // A suffix range ("-500") has no start; home answers those too.
    let start = start.trim().parse().ok()?;
    let end = match end.trim() {
        "" => None,
        end => Some(end.parse().ok()?),
    };
    if end.is_some_and(|end| end < start) {
        return None;
    }
    Some(Wanted { start, end })
}

/// `bytes 100-199/1000` to (100, Some(1000)); a `*` length to None.
fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let spec = value.trim().strip_prefix("bytes ")?;
    let (range, total) = spec.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    let total = match total.trim() {
        "*" => None,
        total => Some(total.parse().ok()?),
    };
    Some((start.trim().parse().ok()?, total))
}

/// Home, through whichever network path is live at the moment of asking.
pub struct Home(pub Arc<RwLock<Option<Arc<Proxy>>>>);

impl Upstream for Home {
    fn open(&self, path: &str, from: u64) -> BoxFuture<'static, Result<Opened, Failure>> {
        let route = self.0.clone();
        let path = path.to_owned();
        Box::pin(async move {
            let proxy = route
                .read()
                .await
                .clone()
                .ok_or_else(|| Failure::Unreachable(anyhow!("no route to home yet")))?;
            let response = proxy
                .open_from(&path, from)
                .await
                .map_err(Failure::Unreachable)?;
            let status = response.status().as_u16();
            let headers = response.headers();
            let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
            let (start, total) = match status {
                206 => header("content-range")
                    .and_then(parse_content_range)
                    .ok_or_else(|| {
                        Failure::Unreachable(anyhow!("a 206 without a usable Content-Range"))
                    })?,
                200 => (0, header("content-length").and_then(|v| v.parse().ok())),
                status => return Err(Failure::Status(status)),
            };
            let content_type = headers.get("content-type").cloned();
            let validator = headers
                .get("etag")
                .or_else(|| headers.get("last-modified"))
                .cloned();
            let body = response
                .bytes_stream()
                .map(|chunk| {
                    chunk
                        .map(|bytes| bytes.to_vec())
                        .map_err(anyhow::Error::from)
                })
                .boxed();
            Ok(Opened {
                start,
                total,
                content_type,
                validator,
                body,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::collections::VecDeque;

    /// What the fake home does for one request.
    #[derive(Clone, Copy, Debug)]
    enum Act {
        /// Everything from the offset asked for.
        Serve,
        /// This many bytes, then the connection closes cleanly.
        CloseAfter(usize),
        /// This many bytes, then a reset.
        ResetAfter(usize),
        /// This many bytes, then nothing, for ever.
        HangAfter(usize),
        Status(u16),
        Refuse,
        /// Everything, with no length given.
        Unsized,
        /// The song is replaced at home by another of the same length, and
        /// this answer is from the new one.
        Replace,
        /// As Replace, but this answer carries no ETag or Last-Modified.
        ReplaceQuietly,
    }

    struct Fake {
        data: Arc<Vec<u8>>,
        /// The same length as `data`, different bytes. See Act::Replace.
        replacement: Arc<Vec<u8>>,
        replaced: std::sync::atomic::AtomicBool,
        script: Mutex<VecDeque<Act>>,
        opens: Mutex<Vec<u64>>,
    }

    impl Fake {
        fn new(len: usize, script: &[Act]) -> Arc<Self> {
            Arc::new(Self {
                data: Arc::new((0..len).map(|i| (i * 31 + i / 4099) as u8).collect()),
                replacement: Arc::new((0..len).map(|i| (i * 7 + 3) as u8).collect()),
                replaced: std::sync::atomic::AtomicBool::new(false),
                script: Mutex::new(script.iter().copied().collect()),
                opens: Mutex::new(Vec::new()),
            })
        }

        fn opens(&self) -> Vec<u64> {
            self.opens.lock().unwrap().clone()
        }
    }

    impl Upstream for Fake {
        fn open(&self, _path: &str, from: u64) -> BoxFuture<'static, Result<Opened, Failure>> {
            self.opens.lock().unwrap().push(from);
            let act = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Act::Serve);
            if matches!(act, Act::Replace | Act::ReplaceQuietly) {
                self.replaced.store(true, Ordering::SeqCst);
            }
            let replaced = self.replaced.load(Ordering::SeqCst);
            let data = if replaced {
                self.replacement.clone()
            } else {
                self.data.clone()
            };
            let validator = HeaderValue::from_static(if replaced { "\"v2\"" } else { "\"v1\"" });
            Box::pin(async move {
                let total = data.len() as u64;
                let rest = data[(from as usize).min(data.len())..].to_vec();
                let pieces = |bytes: &[u8]| -> Vec<Result<Vec<u8>>> {
                    bytes.chunks(64 * 1024).map(|c| Ok(c.to_vec())).collect()
                };
                let total = match act {
                    Act::Unsized => None,
                    _ => Some(total),
                };
                let body = match act {
                    Act::Serve | Act::Unsized | Act::Replace | Act::ReplaceQuietly => {
                        stream::iter(pieces(&rest)).boxed()
                    }
                    Act::CloseAfter(n) => stream::iter(pieces(&rest[..n.min(rest.len())])).boxed(),
                    Act::ResetAfter(n) => stream::iter(pieces(&rest[..n.min(rest.len())]))
                        .chain(stream::once(async { Err(anyhow!("connection reset")) }))
                        .boxed(),
                    Act::HangAfter(n) => stream::iter(pieces(&rest[..n.min(rest.len())]))
                        .chain(stream::pending())
                        .boxed(),
                    Act::Status(status) => return Err(Failure::Status(status)),
                    Act::Refuse => return Err(Failure::Unreachable(anyhow!("connection refused"))),
                };
                Ok(Opened {
                    start: from,
                    total,
                    content_type: Some(HeaderValue::from_static("audio/flac")),
                    validator: (!matches!(act, Act::ReplaceQuietly)).then_some(validator),
                    body,
                })
            })
        }
    }

    const MIB: usize = 1024 * 1024;
    const KEY: &str = "/api/player/stream?id=spiral";

    fn quick() -> Timing {
        Timing {
            stall: Duration::from_millis(500),
            give_up: Duration::from_millis(1500),
            retry: Duration::from_millis(5),
            retry_max: Duration::from_millis(40),
        }
    }

    /// Removes a test's directory when the test ends, passed or failed.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        Scratch(std::env::temp_dir().join(format!(
            "cdz-nutz-stream-test-{name}-{}",
            std::process::id()
        )))
    }

    fn streams(name: &str, fake: &Arc<Fake>) -> (Streams, Scratch) {
        let dir = scratch(name);
        (Streams::new(fake.clone(), dir.0.clone(), quick()), dir)
    }

    fn body_of(response: &http::Response<Vec<u8>>) -> &[u8] {
        response.body()
    }

    fn header<'a>(response: &'a http::Response<Vec<u8>>, name: &str) -> &'a str {
        response.headers()[name].to_str().unwrap()
    }

    /// Read the whole song the way a player does: a chunk, then the next.
    async fn play_through(streams: &Streams, key: &str, len: usize) -> Vec<u8> {
        let mut heard = Vec::with_capacity(len);
        while heard.len() < len {
            let response = streams
                .serve(key, &format!("bytes={}-", heard.len()))
                .await
                .unwrap_or_else(|| panic!("no answer at byte {}", heard.len()));
            assert_eq!(response.status(), 206);
            heard.extend_from_slice(body_of(&response));
        }
        heard
    }

    /// play_through, for a song home replaces part-way through. A request
    /// whose read overlaps the restart is rightly handed back to home (None);
    /// a player would get those bytes from home, so here it just asks again.
    async fn play_through_a_replacement(streams: &Streams, key: &str, len: usize) -> Vec<u8> {
        let mut heard = Vec::with_capacity(len);
        let mut handed_back = 0;
        while heard.len() < len {
            match streams.serve(key, &format!("bytes={}-", heard.len())).await {
                Some(response) => heard.extend_from_slice(body_of(&response)),
                None => {
                    handed_back += 1;
                    assert!(
                        handed_back < 100,
                        "no answer at byte {} for good",
                        heard.len()
                    );
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        }
        heard
    }

    /// The hand-back itself: an answer read while the file was started again
    /// could mix two files under one Content-Range, so it is not sent.
    #[tokio::test]
    async fn an_answer_read_across_a_restart_is_handed_back_to_home() {
        let dir = scratch("generation");
        std::fs::create_dir_all(&dir.0).unwrap();
        let entry = Entry {
            key: KEY.to_owned(),
            file: dir.0.join("song.audio"),
            progress: watch::channel(Progress {
                have: 10,
                total: Some(10),
                ..Progress::default()
            })
            .0,
            task: Mutex::new(None),
        };
        std::fs::write(&entry.file, b"0123456789").unwrap();
        let before = entry.progress.borrow().clone();

        let same = answer(&entry, &before, 2, 5, 10).await.expect("answered");
        assert_eq!(body_of(&same), b"2345");

        entry.progress.send_modify(|p| p.generation += 1);
        assert!(answer(&entry, &before, 2, 5, 10).await.is_none());
    }

    #[tokio::test]
    async fn the_player_is_answered_from_one_download() {
        let fake = Fake::new(10 * MIB, &[]);
        let (streams, _dir) = streams("one-download", &fake);

        let first = streams.serve(KEY, "bytes=0-").await.expect("answered");
        assert_eq!(first.status(), 206);
        let last = body_of(&first).len() - 1;
        assert_eq!(
            header(&first, "content-range"),
            format!("bytes 0-{last}/{}", 10 * MIB)
        );
        assert_eq!(body_of(&first), &fake.data[..=last]);
        assert_eq!(header(&first, "content-type"), "audio/flac");

        let window = streams.serve(KEY, "bytes=5000000-5000999").await.unwrap();
        assert_eq!(
            header(&window, "content-range"),
            format!("bytes 5000000-5000999/{}", 10 * MIB)
        );
        assert_eq!(body_of(&window), &fake.data[5_000_000..5_001_000]);

        assert_eq!(
            play_through(&streams, KEY, 10 * MIB).await,
            *fake.data,
            "every byte the player hears is the file's"
        );
        assert_eq!(
            fake.opens(),
            vec![0],
            "one request to home for the whole song"
        );
    }

    /// The 2026-11-25 failure: home goes away part-way through a song.
    #[tokio::test]
    async fn a_restart_at_home_mid_song_never_reaches_the_player() {
        let fake = Fake::new(
            12 * MIB,
            &[
                Act::ResetAfter(5 * MIB),
                Act::Refuse,
                Act::Status(502),
                Act::Status(502),
                Act::CloseAfter(MIB),
                Act::Serve,
            ],
        );
        let (streams, _dir) = streams("restart", &fake);

        assert_eq!(play_through(&streams, KEY, 12 * MIB).await, *fake.data);
        let opens = fake.opens();
        assert_eq!(opens[0], 0);
        assert!(
            opens[1..5].iter().all(|&from| from == 5 * MIB as u64),
            "each retry asks for the bytes from where it stopped, not the song again: {opens:?}"
        );
        assert_eq!(opens[5], 6 * MIB as u64);
    }

    /// Two files joined at the byte where the connection dropped would be
    /// neither song. Equal lengths, so only the validator can tell.
    #[tokio::test]
    async fn a_song_replaced_at_home_mid_download_starts_again() {
        let fake = Fake::new(4 * MIB, &[Act::CloseAfter(MIB), Act::Replace]);
        let (streams, _dir) = streams("replaced", &fake);

        let heard = play_through_a_replacement(&streams, KEY, 4 * MIB).await;
        assert!(
            heard[2 * MIB..] == fake.replacement[2 * MIB..],
            "after the change the player hears the new file"
        );
        assert_eq!(
            fake.opens(),
            vec![0, MIB as u64, 0],
            "the new file from its first byte"
        );
    }

    /// Without a validator a resumed answer cannot be shown to be the same
    /// file, so it is not joined onto what is on disk.
    #[tokio::test]
    async fn a_resumed_answer_that_cannot_be_checked_starts_again() {
        let fake = Fake::new(4 * MIB, &[Act::CloseAfter(MIB), Act::ReplaceQuietly]);
        let (streams, _dir) = streams("unverified", &fake);

        let heard = play_through_a_replacement(&streams, KEY, 4 * MIB).await;
        assert!(
            heard[2 * MIB..] == fake.replacement[2 * MIB..],
            "the player hears one file, not two joined"
        );
        assert_eq!(
            fake.opens(),
            vec![0, MIB as u64, 0],
            "the unverified answer is dropped and the file fetched from the top"
        );
    }

    #[tokio::test]
    async fn an_answer_before_any_audio_is_left_to_home() {
        let fake = Fake::new(MIB, &[Act::Status(404)]);
        let (streams, _dir) = streams("404", &fake);
        assert!(streams.serve(KEY, "bytes=0-").await.is_none());
    }

    #[tokio::test]
    async fn a_song_home_gives_no_length_for_is_left_to_home() {
        let fake = Fake::new(MIB, &[Act::Unsized]);
        let (streams, _dir) = streams("unsized", &fake);
        assert!(streams.serve(KEY, "bytes=0-").await.is_none());
        assert_eq!(
            fake.opens(),
            vec![0],
            "not retried: a retry would not say either"
        );
    }

    #[tokio::test]
    async fn a_seek_far_past_the_download_goes_straight_to_home() {
        let fake = Fake::new(40 * MIB, &[Act::HangAfter(MIB)]);
        let (streams, _dir) = streams("seek", &fake);

        let early = streams.serve(KEY, "bytes=0-1023").await.unwrap();
        assert_eq!(body_of(&early), &fake.data[..1024]);

        let asked = Instant::now();
        assert!(streams.serve(KEY, "bytes=30000000-").await.is_none());
        assert!(
            asked.elapsed() < quick().stall,
            "must not wait for the download to get there"
        );
    }

    #[tokio::test]
    async fn past_the_end_and_odd_ranges_are_left_to_home() {
        let fake = Fake::new(MIB, &[]);
        let (streams, _dir) = streams("odd", &fake);
        for range in [
            format!("bytes={}-", MIB),
            "bytes=-500".to_owned(),
            "bytes=0-99,200-299".to_owned(),
            "items=0-10".to_owned(),
        ] {
            assert!(streams.serve(KEY, &range).await.is_none(), "{range}");
        }
    }

    #[tokio::test]
    async fn a_download_that_gives_up_starts_again_when_the_player_asks() {
        let refusals = vec![Act::Refuse; 400];
        let script: Vec<Act> = std::iter::once(Act::CloseAfter(MIB))
            .chain(refusals)
            .collect();
        let fake = Fake::new(4 * MIB, &script);
        let (streams, _dir) = streams("give-up", &fake);

        assert!(streams.serve(KEY, "bytes=0-1023").await.is_some());
        // Home stays away past give_up. The request gets no answer from the
        // read-ahead, so the caller forwards it and the player hears the error.
        assert!(streams
            .serve(KEY, &format!("bytes={}-", 2 * MIB))
            .await
            .is_none());
        tokio::time::sleep(quick().give_up).await;

        // Home is back. The player's retry starts the download again, from
        // the byte it had reached.
        fake.script.lock().unwrap().clear();
        let resumed = streams
            .serve(KEY, &format!("bytes={}-", 2 * MIB))
            .await
            .unwrap();
        assert_eq!(
            body_of(&resumed)[..1024],
            fake.data[2 * MIB..2 * MIB + 1024]
        );
        assert_eq!(*fake.opens().last().unwrap(), MIB as u64);
    }

    /// The state of `key`'s download, without asking for it (which would
    /// start a stopped one again).
    fn state_of(streams: &Streams, key: &str) -> State {
        let entries = streams.entries.lock().unwrap();
        let entry = entries.iter().find(|e| e.key == key).unwrap();
        let state = entry.progress.borrow().state;
        state
    }

    #[tokio::test]
    async fn a_song_skipped_past_stops_downloading_and_carries_on_if_asked_for() {
        let fake = Fake::new(4 * MIB, &[Act::HangAfter(MIB), Act::HangAfter(MIB)]);
        let (streams, _dir) = streams("running", &fake);
        let [a, b, c] =
            ["skipped", "buffered", "playing"].map(|id| format!("{STREAM_PATH}?id={id}"));

        assert!(streams.serve(&a, "bytes=0-1023").await.is_some());
        assert!(streams.serve(&b, "bytes=0-1023").await.is_some());
        assert_eq!(state_of(&streams, &a), State::Running);
        assert!(streams.serve(&c, "bytes=0-1023").await.is_some());

        assert_eq!(state_of(&streams, &a), State::Failed, "the oldest stops");
        assert_eq!(state_of(&streams, &b), State::Running);

        // Previous: the song carries on from the byte it reached.
        let back = streams.serve(&a, &format!("bytes={MIB}-")).await.unwrap();
        assert_eq!(body_of(&back)[..1024], fake.data[MIB..MIB + 1024]);
        assert_eq!(*fake.opens().last().unwrap(), MIB as u64);
    }

    #[tokio::test]
    async fn a_song_replaced_at_home_counts_progress_on_the_new_file() {
        // The first download gets 2 MiB in, home replaces the song, and the
        // new file keeps dropping below where the old one had got to.
        let script: Vec<Act> = [Act::CloseAfter(2 * MIB), Act::Replace]
            .into_iter()
            .chain(std::iter::repeat_n(Act::CloseAfter(64 * 1024), 30))
            .collect();
        let fake = Fake::new(4 * MIB, &script);
        let dir = scratch("replaced-progress");
        let timing = Timing {
            give_up: Duration::from_millis(200),
            ..quick()
        };
        let streams = Streams::new(fake.clone(), dir.0.clone(), timing);

        assert!(streams.serve(KEY, "bytes=0-1023").await.is_some());
        let deadline = Instant::now() + Duration::from_secs(10);
        while state_of(&streams, KEY) == State::Running {
            assert!(Instant::now() < deadline, "the download never finished");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            state_of(&streams, KEY),
            State::Done,
            "it gave up while moving"
        );
        let heard = play_through(&streams, KEY, 4 * MIB).await;
        assert!(heard == *fake.replacement, "the player gets the new file");
    }

    #[tokio::test]
    async fn only_the_last_few_songs_stay_on_disk() {
        let fake = Fake::new(MIB, &[]);
        let (streams, _dir) = streams("keep", &fake);
        for song in 0..5 {
            let key = format!("/api/player/stream?id={song}");
            play_through(&streams, &key, MIB).await;
        }
        let files = std::fs::read_dir(streams.dir.as_ref().unwrap())
            .unwrap()
            .count();
        assert_eq!(files, KEEP);
    }

    /// Talks to the real pi-server, so it is ignored by default and CI never
    /// runs it. On the home LAN:
    ///
    ///     cargo test -- --ignored --nocapture read_ahead_answers
    #[tokio::test]
    #[ignore = "needs the home LAN"]
    async fn read_ahead_answers_what_home_would() {
        let _ = env_logger::builder()
            .is_test(true)
            .filter_level(log::LevelFilter::Info)
            .try_init();
        let proxy = Arc::new(Proxy::new(crate::netpath::Path::Lan, None).expect("client builds"));
        let route = Arc::new(RwLock::new(Some(proxy.clone())));
        let dir = scratch("live");
        let streams = Streams::new(Arc::new(Home(route)), dir.0.clone(), Timing::default());
        // The song that stopped at 3:22 on 2026-11-25.
        let key = "/api/player/stream?id=1aLR61JqiSag5LFjARQd0N";

        // Played through the way a player reads: from the top, a chunk at a time.
        let started = Instant::now();
        let first = streams.serve(key, "bytes=0-1").await.expect("answered");
        let total: u64 = header(&first, "content-range")
            .rsplit('/')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let heard = play_through(&streams, key, total as usize).await;
        assert_eq!(heard.len() as u64, total, "the whole file arrives");
        println!(
            "{total} bytes read ahead in {:.1}s",
            started.elapsed().as_secs_f64()
        );

        // Then the same windows asked of home directly: same head, same bytes.
        for range in ["bytes=0-1", "bytes=25165824-25231359", "bytes=25000000-"] {
            let ours = streams.serve(key, range).await.expect("answered");
            assert_eq!(ours.status(), 206, "{range}");
            let window = header(&ours, "content-range")
                .strip_prefix("bytes ")
                .and_then(|spec| spec.split_once('/'))
                .map(|(window, _)| window.to_owned())
                .unwrap();
            let mut ask = http::HeaderMap::new();
            ask.insert(
                "range",
                HeaderValue::from_str(&format!("bytes={window}")).unwrap(),
            );
            let home = proxy
                .forward("GET", key, &ask, Vec::new())
                .await
                .expect("home answers");
            assert_eq!(home.status(), 206, "{range}");
            for name in ["content-range", "content-type", "content-length"] {
                assert_eq!(header(&ours, name), header(&home, name), "{range}: {name}");
            }
            assert!(
                body_of(&ours) == body_of(&home),
                "{range}: the bytes differ"
            );
        }
    }

    #[test]
    fn range_headers() {
        assert_eq!(
            parse_range("bytes=0-"),
            Some(Wanted {
                start: 0,
                end: None
            })
        );
        assert_eq!(
            parse_range("bytes=10-19"),
            Some(Wanted {
                start: 10,
                end: Some(19)
            })
        );
        assert_eq!(parse_range("bytes=20-10"), None);
        assert_eq!(parse_range("bytes=-500"), None);
        assert_eq!(parse_range("bytes=0-1,5-"), None);
        assert_eq!(parse_range("0-"), None);
    }

    #[test]
    fn content_range_headers() {
        assert_eq!(
            parse_content_range("bytes 100-199/1000"),
            Some((100, Some(1000)))
        );
        assert_eq!(parse_content_range("bytes 0-0/*"), Some((0, None)));
        assert_eq!(parse_content_range("bytes */1000"), None);
        assert_eq!(parse_content_range("100-199/1000"), None);
    }
}
