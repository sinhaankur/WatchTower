import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import SetupWizard from './pages/SetupWizard';
import Dashboard from './pages/Dashboard';
import TeamManagement from './pages/TeamManagement';
import NodeManagement from './pages/NodeManagement';
import GitHubOAuthCallback from './pages/GitHubOAuthCallback';
import Layout from './components/Layout';
import './App.css';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Pages with shared sidebar layout */}
          <Route path="/" element={<Layout><Dashboard /></Layout>} />
          <Route path="/nodes" element={<Layout><NodeManagement /></Layout>} />
          <Route path="/team" element={<Layout><TeamManagement /></Layout>} />
          {/* Full-screen pages (wizard & oauth flow — no sidebar) */}
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/oauth/github/callback" element={<GitHubOAuthCallback />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
