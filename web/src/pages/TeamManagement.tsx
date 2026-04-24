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

const ROLE_META: Record<TeamMember['role'], { label: string; color: string }> = {
  owner:     { label: 'Owner',     color: 'bg-amber-50 text-amber-700 border-amber-200' },
  admin:     { label: 'Admin',     color: 'bg-purple-50 text-purple-700 border-purple-200' },
  developer: { label: 'Developer', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  viewer:    { label: 'Viewer',    color: 'bg-gray-50 text-gray-600 border-gray-200' },
};

const TeamManagement = () => {
  const [orgId, setOrgId] = useState('');
  const [orgName, setOrgName] = useState('');
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [connections, setConnections] = useState<GitHubConnection[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamMember['role']>('developer');
  const [loading, setLoading] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [pageError, setPageError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [inviting, setInviting] = useState(false);

  const ownerCount = useMemo(() => members.filter((m) => m.role === 'owner').length, [members]);

  const refreshData = async (currentOrgId: string) => {
    try {
      const [membersResp, connectionsResp] = await Promise.all([
        apiClient.get(`/orgs/${currentOrgId}/team-members`),
        apiClient.get(`/orgs/${currentOrgId}/github-connections`),
      ]);
      setMembers(membersResp.data as TeamMember[]);
      setConnections(connectionsResp.data as GitHubConnection[]);
    } catch {
      // non-fatal
    }
  };

  const loadContext = async () => {
    setLoading(true);
    setPageError('');
    setOfflineMode(false);
    try {
      const ctxResp = await apiClient.get('/context');
      const context = ctxResp.data as ContextResponse;
      setOrgId(context.organization.id);
      setOrgName(context.organization.name);
      await refreshData(context.organization.id);
    } catch {
      setOfflineMode(true);
      setPageError('Could not connect to the WatchTower server. Check that the API is running and your API token is configured.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadContext(); }, []);

  const inviteMember = async () => {
    if (!orgId || !email.trim()) return;
    setInviting(true);
    setActionError('');
    setActionSuccess('');
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
      setActionSuccess(`Invitation sent to ${email}.`);
      await refreshData(orgId);
    } catch {
      setActionError('Failed to invite member. Check the email address and try again.');
    } finally {
      setInviting(false);
    }
  };

  const startOAuth = async (provider: 'github_com' | 'github_enterprise') => {
    if (!orgId) return;
    setActionError('');
    try {
      const redirectUri = `${window.location.origin}/oauth/github/callback`;
      const resp = await apiClient.get('/github/oauth/start', {
        params: { org_id: orgId, provider, redirect_uri: redirectUri },
      });
      window.location.href = (resp.data as { authorize_url: string }).authorize_url;
    } catch {
      setActionError('GitHub OAuth setup failed. Ensure GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set on the server.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-4xl mx-auto px-6 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Team</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading ? 'Loading…' : orgName ? `Organization: ${orgName}` : offlineMode ? 'Server offline' : ''}
            </p>
          </div>
          <div className="flex gap-2">
            {offlineMode && (
              <Button variant="outline" onClick={() => void loadContext()} className="rounded-none border-gray-300 text-sm">
                Retry Connection
              </Button>
            )}
            <Link to="/">
              <Button variant="outline" className="rounded-none border-gray-200 text-sm">← Dashboard</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">

        {pageError && (
          <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
            <span className="text-amber-500 mt-0.5">⚠</span>
            <div>
              <p className="text-sm font-medium text-amber-800">Connection issue</p>
              <p className="text-sm text-amber-700 mt-0.5">{pageError}</p>
            </div>
          </div>
        )}

        {actionSuccess && (
          <div className="flex items-center gap-2 border border-green-200 bg-green-50 px-4 py-3">
            <span className="text-green-500">✓</span>
            <p className="text-sm text-green-700">{actionSuccess}</p>
          </div>
        )}

        {actionError && (
          <div className="flex items-start gap-2 border border-red-200 bg-red-50 px-4 py-3">
            <span className="text-red-500 mt-0.5">✗</span>
            <p className="text-sm text-red-700">{actionError}</p>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-5">
          {/* Invite */}
          <Card className="rounded-none border-gray-200 shadow-none bg-white">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Invite a Team Member</CardTitle>
              <CardDescription>Send an invite by email and choose their access level.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="invite_email">Email address</Label>
                <Input id="invite_email" type="email" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void inviteMember()}
                  className="mt-1.5 rounded-none border-gray-300"
                  placeholder="engineer@example.com" />
              </div>
              <div>
                <Label htmlFor="invite_role">Role</Label>
                <select id="invite_role" value={role}
                  onChange={(e) => setRole(e.target.value as TeamMember['role'])}
                  className="mt-1.5 w-full border border-gray-300 h-10 px-3 text-sm bg-white">
                  <option value="developer">Developer — can create projects & deploy</option>
                  <option value="viewer">Viewer — read-only access</option>
                  <option value="admin">Admin — manage nodes, team & deployments</option>
                  <option value="owner">Owner — full access</option>
                </select>
              </div>
              <Button onClick={() => void inviteMember()}
                disabled={inviting || offlineMode || !orgId || !email.trim()}
                className="w-full bg-gray-900 text-white hover:bg-gray-800 rounded-none">
                {inviting ? 'Sending invite…' : offlineMode ? 'Server offline' : 'Send Invite'}
              </Button>
            </CardContent>
          </Card>

          {/* GitHub Connections */}
          <Card className="rounded-none border-gray-200 shadow-none bg-white">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">GitHub Connections</CardTitle>
              <CardDescription>Link GitHub accounts so WatchTower can pull repositories.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => void startOAuth('github_com')}
                  disabled={loading || !orgId || offlineMode}
                  className="bg-gray-900 text-white hover:bg-gray-800 rounded-none text-sm">
                  🔗 GitHub.com
                </Button>
                <Button onClick={() => void startOAuth('github_enterprise')}
                  disabled={loading || !orgId || offlineMode}
                  variant="outline" className="rounded-none border-gray-300 text-sm">
                  🏢 GitHub Enterprise
                </Button>
              </div>
              <p className="text-xs text-gray-400">You'll be redirected to GitHub to authorize access.</p>

              {connections.length === 0 && !loading && (
                <div className="py-4 text-center border border-dashed border-gray-200">
                  <p className="text-xs text-gray-400">No GitHub accounts connected yet.</p>
                </div>
              )}
              <div className="space-y-2">
                {connections.map((conn) => (
                  <div key={conn.id} className="border border-gray-200 bg-gray-50 px-3 py-2.5 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">@{conn.github_username}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {conn.provider === 'github_enterprise' ? (conn.enterprise_name ?? 'GitHub Enterprise') : 'GitHub.com'}
                        {conn.is_primary && <span className="ml-2 text-blue-600">· Primary</span>}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 border rounded-full ${conn.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-400 border-gray-200'}`}>
                      {conn.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Members list */}
        <Card className="rounded-none border-gray-200 shadow-none bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Team Members</CardTitle>
            <CardDescription>
              {loading ? 'Loading members…' : `${members.length} member${members.length !== 1 ? 's' : ''} · ${ownerCount} owner${ownerCount !== 1 ? 's' : ''}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!loading && members.length === 0 && (
              <div className="py-10 text-center border border-dashed border-gray-200">
                <p className="text-2xl mb-2">👥</p>
                <p className="text-sm font-medium text-gray-600">No team members yet</p>
                <p className="text-xs text-gray-400 mt-1">Use the form above to invite your first teammate.</p>
              </div>
            )}
            <div className="space-y-2">
              {members.map((member) => {
                const roleMeta = ROLE_META[member.role];
                return (
                  <div key={member.id} className="border border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{member.email}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className={`text-xs px-2 py-0.5 border rounded-full ${roleMeta.color}`}>{roleMeta.label}</span>
                        {member.can_create_projects && <span className="text-xs text-gray-400">Projects</span>}
                        {member.can_manage_deployments && <span className="text-xs text-gray-400">Deploy</span>}
                        {member.can_manage_nodes && <span className="text-xs text-gray-400">Nodes</span>}
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 border rounded-full shrink-0 ${member.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                      {member.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default TeamManagement;
