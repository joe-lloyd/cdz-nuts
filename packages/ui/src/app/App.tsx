// The application shell.
//
// Scaffold only at this point: it exists to prove the build pipeline reaches
// both consumers before any UI is ported. The real shell -- sidebar, page head,
// player bar, queue and lyrics panels -- arrives with the port.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { pathFromLegacyHash } from './routes.ts';

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

function Placeholder() {
  return (
    <main id="main" tabIndex={-1}>
      <div className="empty">
        React shell is mounted. Views are being ported.
      </div>
    </main>
  );
}

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
          <Route path="*" element={<Placeholder />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
