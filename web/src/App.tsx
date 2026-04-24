import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import SetupWizard from './pages/SetupWizard';
import Dashboard from './pages/Dashboard';
import TeamManagement from './pages/TeamManagement';
import NodeManagement from './pages/NodeManagement';
import GitHubOAuthCallback from './pages/GitHubOAuthCallback';
import './App.css';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/team" element={<TeamManagement />} />
          <Route path="/nodes" element={<NodeManagement />} />
          <Route path="/oauth/github/callback" element={<GitHubOAuthCallback />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
