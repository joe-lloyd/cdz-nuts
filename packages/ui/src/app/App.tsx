// The application shell.
//
// Scaffold only at this point: it exists to prove the build pipeline reaches
// both consumers before any UI is ported. The real shell -- sidebar, page head,
// player bar, queue and lyrics panels -- arrives with the port.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter, Route, Routes } from 'react-router-dom';

// Hash routing, not browser routing. The existing app is entirely #hash-based
// (`#album/<id>`, `#radio/artist/<name>`), those URLs are bookmarked and are
// what the phone app's WebView opens, and the desktop shell serves from a
// custom scheme where path routing would need server-side rewrites it does not
// have. Keeping hashes is a compatibility requirement, not a preference.
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

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="*" element={<Placeholder />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
