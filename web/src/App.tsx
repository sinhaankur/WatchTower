import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import SetupWizard from './pages/SetupWizard';
import Dashboard from './pages/Dashboard';
import TeamManagement from './pages/TeamManagement';
import NodeManagement from './pages/NodeManagement';
import GitHubOAuthCallback from './pages/GitHubOAuthCallback';
import GitHubLoginCallback from './pages/GitHubLoginCallback';
import Login from './pages/Login';
import Layout from './components/Layout';
import './App.css';

const queryClient = new QueryClient();

function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation();
  const envToken = (import.meta as any).env?.VITE_API_TOKEN;
  const token = localStorage.getItem('authToken') || envToken;

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}

function App() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      document.documentElement.setAttribute('data-theme', media.matches ? 'dark' : 'light');
    };

    applyTheme();

    if (media.addEventListener) {
      media.addEventListener('change', applyTheme);
      return () => media.removeEventListener('change', applyTheme);
    }

    media.addListener(applyTheme);
    return () => media.removeListener(applyTheme);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/oauth/github/login/callback" element={<GitHubLoginCallback />} />

          {/* Pages with shared sidebar layout */}
          <Route path="/" element={<RequireAuth><Layout><Dashboard /></Layout></RequireAuth>} />
          <Route path="/nodes" element={<RequireAuth><Layout><NodeManagement /></Layout></RequireAuth>} />
          <Route path="/team" element={<RequireAuth><Layout><TeamManagement /></Layout></RequireAuth>} />
          {/* Full-screen pages (wizard & oauth flow — no sidebar) */}
          <Route path="/setup" element={<RequireAuth><SetupWizard /></RequireAuth>} />
          <Route path="/oauth/github/callback" element={<RequireAuth><GitHubOAuthCallback /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
