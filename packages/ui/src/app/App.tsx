import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { pathFromLegacyHash } from './routes.tsx';
import { Shell } from './Shell.tsx';
import { Overview } from '../views/Overview.tsx';
import { Albums, Artists, Latest, PlaylistDetail, Playlists, Plays, Songs } from '../views/Library.tsx';
import { AlbumDetail, ArtistDetail, Shows } from '../views/Detail.tsx';
import { Radio, Station } from '../views/Radio.tsx';
import { Top } from '../views/Top.tsx';
import { Cds } from '../views/Cds.tsx';
import { Upgrades } from '../views/Upgrades.tsx';
import { Empty } from '../components/primitives.tsx';

// Real paths, not hashes. That needs a catch-all on both consumers --
// music-dump serves the document for any unknown non-API path, and the Tauri
// protocol handler does the same from embedded bytes -- because otherwise a
// hard load of /album/123 is a 404 rather than a route.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The archive changes on a nightly sync, not per second. This replaces
      // the old `cache = {}` memo-forever behaviour with something that at
      // least expires, while keeping navigation instant.
      staleTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Old #hash URLs are bookmarked, sit in the phone app's WebView history, and
// are linked from the dashboard. Migrate before the router mounts, so it only
// ever sees a path -- and use replaceState so the dead hash does not become a
// history entry the back button returns to.
const legacy = pathFromLegacyHash(window.location.hash);
if (legacy) window.history.replaceState(null, '', legacy);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/artists" element={<Artists />} />
            <Route path="/liked" element={<Songs />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/latest" element={<Latest />} />
            <Route path="/plays" element={<Plays />} />
            <Route path="/shows" element={<Shows />} />
            <Route path="/top" element={<Top />} />
            <Route path="/cds" element={<Cds />} />
            <Route path="/upgrades" element={<Upgrades />} />
            <Route path="/radio" element={<Radio />} />
            <Route path="/radio/:kind/*" element={<StationRoute />} />
            <Route path="/artist/:id" element={<ArtistDetail />} />
            <Route path="/album/:id" element={<AlbumDetail />} />
            <Route path="/playlist/:id" element={<PlaylistDetail />} />
            <Route path="*" element={<Empty>That page does not exist.</Empty>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

/**
 * A station seed is an artist name or a genre, not an id, so it can contain
 * slashes and spaces. The splat route captures the rest of the path verbatim
 * rather than squeezing the seed into a single segment.
 */
function StationRoute() {
  return <Station />;
}
