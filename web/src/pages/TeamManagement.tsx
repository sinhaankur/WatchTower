import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ContextResponse = {
  organization: {
    id: string;
    name: string;
  };
};

type TeamMember = {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  can_create_projects: boolean;
  can_manage_deployments: boolean;
  can_manage_nodes: boolean;
  can_manage_team: boolean;
  is_active: boolean;
};

type GitHubConnection = {
  id: string;
  provider: 'github_com' | 'github_enterprise';
  github_username: string;
  enterprise_name?: string;
  is_primary: boolean;
  is_active: boolean;
  last_synced?: string;
};

const TeamManagement = () => {
  const [orgId, setOrgId] = useState<string>('');
  const [orgName, setOrgName] = useState<string>('');
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [connections, setConnections] = useState<GitHubConnection[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('developer');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ownerCount = useMemo(() => members.filter((m) => m.role === 'owner').length, [members]);

  const refreshData = async (currentOrgId: string) => {
    const [membersResp, connectionsResp] = await Promise.all([
      apiClient.get(`/orgs/${currentOrgId}/team-members`),
      apiClient.get(`/orgs/${currentOrgId}/github-connections`),
    ]);
    setMembers(membersResp.data as TeamMember[]);
    setConnections(connectionsResp.data as GitHubConnection[]);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const ctxResp = await apiClient.get('/context');
        const context = ctxResp.data as ContextResponse;
        setOrgId(context.organization.id);
        setOrgName(context.organization.name);
        await refreshData(context.organization.id);
      } catch {
        setError('Unable to load team data. Ensure API token/auth is configured.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const inviteMember = async () => {
    if (!orgId || !email.trim()) {
      return;
    }

    setLoading(true);
    setError('');
    try {
      await apiClient.post(`/orgs/${orgId}/team-members`, {
        email,
        role,
        can_create_projects: true,
        can_manage_deployments: role === 'owner' || role === 'admin',
        can_manage_nodes: role === 'owner' || role === 'admin',
        can_manage_team: role === 'owner' || role === 'admin',
      });
      setEmail('');
      setRole('developer');
      await refreshData(orgId);
    } catch {
      setError('Failed to invite team member.');
    } finally {
      setLoading(false);
    }
  };

  const startOAuth = async (provider: 'github_com' | 'github_enterprise') => {
    if (!orgId) {
      return;
    }

    setLoading(true);
    setError('');
    try {
      const redirectUri = `${window.location.origin}/oauth/github/callback`;
      const resp = await apiClient.get('/github/oauth/start', {
        params: {
          org_id: orgId,
          provider,
          redirect_uri: redirectUri,
        },
      });
      const authorizeUrl = (resp.data as { authorize_url: string }).authorize_url;
      window.location.href = authorizeUrl;
    } catch {
      setError('OAuth setup failed. Verify GitHub OAuth env vars are configured.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-6 py-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Team Management</h1>
            <p className="text-sm text-gray-500 mt-1">Organization: {orgName || 'Loading...'}</p>
          </div>
          <Link to="/">
            <Button variant="outline" className="rounded-none border-gray-300">Back to Dashboard</Button>
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {error && (
          <Card className="rounded-none border-red-200 bg-red-50 shadow-none">
            <CardContent className="py-4 text-sm text-red-700">{error}</CardContent>
          </Card>
        )}

        <div className="grid md:grid-cols-2 gap-6">
          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle>Invite Member</CardTitle>
              <CardDescription>Invite teammates and assign a role.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="invite_email">Email</Label>
                <Input
                  id="invite_email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-2 rounded-none border-gray-300"
                  placeholder="engineer@example.com"
                />
              </div>
              <div>
                <Label htmlFor="invite_role">Role</Label>
                <select
                  id="invite_role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as TeamMember['role'])}
                  className="mt-2 w-full border border-gray-300 h-10 px-3 text-sm"
                >
                  <option value="developer">Developer</option>
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <Button
                onClick={inviteMember}
                disabled={loading || !email.trim()}
                className="w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none"
              >
                Invite Member
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-none border-gray-200 shadow-none">
            <CardHeader>
              <CardTitle>GitHub Connections</CardTitle>
              <CardDescription>Connect GitHub accounts for team deployments.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Button
                  onClick={() => void startOAuth('github_com')}
                  disabled={loading || !orgId}
                  className="flex-1 bg-gray-900 text-white hover:bg-gray-800 rounded-none"
                >
                  Connect GitHub.com
                </Button>
                <Button
                  onClick={() => void startOAuth('github_enterprise')}
                  disabled={loading || !orgId}
                  variant="outline"
                  className="flex-1 rounded-none border-gray-300"
                >
                  Connect GHE
                </Button>
              </div>
              <div className="space-y-2">
                {connections.length === 0 && <p className="text-sm text-gray-500">No connections yet.</p>}
                {connections.map((conn) => (
                  <div key={conn.id} className="border border-gray-200 p-3 text-sm">
                    <p className="font-semibold text-gray-900">{conn.github_username}</p>
                    <p className="text-gray-600">
                      {conn.provider === 'github_enterprise' ? (conn.enterprise_name || 'GitHub Enterprise') : 'GitHub.com'}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">{conn.is_primary ? 'Primary' : 'Secondary'} · {conn.is_active ? 'Active' : 'Inactive'}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-none border-gray-200 shadow-none">
          <CardHeader>
            <CardTitle>Team Members</CardTitle>
            <CardDescription>{members.length} member(s) · {ownerCount} owner(s)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {members.map((member) => (
                <div key={member.id} className="border border-gray-200 p-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{member.email}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {member.role} · projects:{member.can_create_projects ? 'yes' : 'no'} · deploy:{member.can_manage_deployments ? 'yes' : 'no'} · nodes:{member.can_manage_nodes ? 'yes' : 'no'}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-1 border ${member.is_active ? 'border-green-300 text-green-700' : 'border-gray-300 text-gray-500'}`}>
                    {member.is_active ? 'active' : 'inactive'}
                  </span>
                </div>
              ))}
              {!loading && members.length === 0 && <p className="text-sm text-gray-500">No members found.</p>}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default TeamManagement;
