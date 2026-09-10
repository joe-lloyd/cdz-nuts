import { useMutation } from '@tanstack/react-query';

import { post } from '../api/client.ts';
import { useDesktop, useUiBuild } from '../api/hooks.ts';
import { Empty, Skeleton } from '../components/primitives.tsx';
import { player } from '../player/usePlayer.ts';

type Found =
  | { state: 'current'; version: string }
  | { state: 'available'; version: string }
  | { state: 'failed'; error: string };

export function Settings() {
  const { data: desktop, isPending, refetch } = useDesktop();

  const check = useMutation({
    mutationFn: () => post<Found>('/api/desktop/update/check', {}),
    onSuccess: (found) => {
      if (found.state === 'available') player.notify(`Version ${found.version} is ready to install`);
      else if (found.state === 'current') player.notify('Already on the latest version');
      else player.notify(found.error, true);
      void refetch();
    },
    onError: (e: Error) => player.notify(e.message, true),
  });

  const install = useMutation({
    mutationFn: () => post<{ state: string }>('/api/desktop/update/install', {}),
    onSuccess: () => player.notify('Installing. The app will restart when it is done.'),
    onError: (e: Error) => player.notify(e.message, true),
  });

  if (isPending) return <Skeleton />;

  return (
    <>
      <h2>Version</h2>
      {desktop ? (
        <>
          <p className="lede">Homelab Music {desktop.version}</p>
          <p className="note">
            {desktop.update_pending
              ? 'An update is downloaded and waiting. Installing restarts the app.'
              : 'The app installs updates for you when it starts. This button is for when you do not want to wait.'}
          </p>
          <div className="hero-actions">
            <button type="button" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? 'Checking…' : 'Check for updates'}
            </button>
            {desktop.update_pending ? (
              <button
                type="button"
                className="primary-action"
                disabled={install.isPending}
                onClick={() => install.mutate()}
              >
                {install.isPending ? 'Installing…' : 'Install and restart'}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <ServerVersion />
      )}
    </>
  );
}

/** In a browser there is no app to update, so say which front end is serving. */
function ServerVersion() {
  const { data, isPending } = useUiBuild();

  if (isPending) return <Skeleton />;
  if (!data) return <Empty>Nothing to configure here yet.</Empty>;
  return (
    <>
      <p className="lede">Web version, front end {data.digest.slice(0, 12)}</p>
      <p className="note">
        Updates apply to the desktop app. In a browser you always get whatever the server is
        serving, so there is nothing to install.
      </p>
    </>
  );
}
