import { useEffect, useMemo, useState } from 'react';
import apiClient from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ContextResponse = {
  user: {
    id: string;
    email: string;
    name: string;
  };
  organization: {
    id: string;
    name: string;
  };
  membership?: {
    id: string;
    role: string;
    can_manage_team: boolean;
    can_manage_nodes: boolean;
    can_manage_deployments: boolean;
  };
  installation?: {
    owner_mode_enabled?: boolean;
    is_claimed?: boolean;
    owner_user_id?: string | null;
    owner_login?: string | null;
    is_owner?: boolean;
  };
  github_connection?: {
    connected?: boolean;
    provider?: string | null;
    github_username?: string | null;
    managed_by_user_id?: string | null;
    last_synced?: string | null;
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
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [canManageTeam, setCanManageTeam] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState('');
  const [updatingMember, setUpdatingMember] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);

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
      setContext(context);
      setOrgId(context.organization.id);
      setOrgName(context.organization.name);
      setCurrentUserEmail(context.user.email);
      setCanManageTeam(context.membership?.can_manage_team ?? true);
      await refreshData(context.organization.id);
    } catch {
      setOfflineMode(true);
      setPageError('Could not connect to the WatchTower server. Check that the API is running and your API token is configured.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadContext();
    // Initial page bootstrap should run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const updateMemberRole = async (memberId: string, newRole: TeamMember['role']) => {
    setUpdatingMember(memberId);
    setActionError('');
    setActionSuccess('');
    try {
      await apiClient.put(`/team-members/${memberId}`, { role: newRole });
      setActionSuccess('Role updated.');
      await refreshData(orgId);
    } catch {
      setActionError('Failed to update role. Check your permissions.');
    } finally {
      setUpdatingMember(null);
    }
  };

  const deactivateMember = async (memberId: string, memberEmail: string) => {
    if (!window.confirm(`Remove ${memberEmail} from the team?`)) return;
    setRemovingMember(memberId);
    setActionError('');
    setActionSuccess('');
    try {
      await apiClient.put(`/team-members/${memberId}`, { is_active: false });
      setActionSuccess(`${memberEmail} has been removed.`);
      await refreshData(orgId);
    } catch {
      setActionError('Failed to remove member.');
    } finally {
      setRemovingMember(null);
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
      setActionError('GitHub OAuth setup failed. Ensure GITHUB_OAUTH_CLIENT_ID/GITHUB_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET/GITHUB_CLIENT_SECRET are set on the server.');
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      <header className="electron-card-solid electron-divider border-b sticky top-0 z-10 backdrop-blur-sm">
        <div className="px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-gray-900">Team</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading ? 'Loading…' : orgName ? `Organization: ${orgName}` : offlineMode ? 'Server offline — showing cached data' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {offlineMode && (
              <Button variant="outline" onClick={() => void loadContext()} className="text-sm">
                ↺ Retry
              </Button>
            )}
            {!offlineMode && (
              <button
                onClick={() => { void loadContext(); }}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg border border-border text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="px-8 py-6 space-y-6 max-w-4xl">

        {context?.installation?.owner_mode_enabled && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3">
            <p className="text-sm font-medium text-blue-900">Installation ownership is enabled</p>
            <p className="text-xs text-blue-800 mt-1">
              {context.installation.is_owner
                ? 'You are the installation owner. You control node governance and GitHub application connectivity.'
                : `This installation is owned by ${context.installation.owner_login || 'another user'}. Node and team access must be granted by owner/admin.`}
            </p>
          </div>
        )}

        {pageError && (
          <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 rounded-md px-4 py-3">
            <span className="text-amber-500 mt-0.5">⚠</span>
            <div>
              <p className="text-sm font-medium text-amber-800">Connection issue</p>
              <p className="text-sm text-amber-700 mt-0.5">{pageError}</p>
            </div>
          </div>
        )}

        {actionSuccess && (
          <div className="flex items-center gap-2 border border-green-200 bg-green-50 rounded-md px-4 py-3">
            <span className="text-green-500">✓</span>
            <p className="text-sm text-green-700">{actionSuccess}</p>
          </div>
        )}

        {actionError && (
          <div className="flex items-start gap-2 border border-red-200 bg-red-50 rounded-md px-4 py-3">
            <span className="text-red-500 mt-0.5">✗</span>
            <p className="text-sm text-red-700">{actionError}</p>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-5">
          {/* Invite */}
          <Card className="electron-card rounded-xl shadow-none">
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
                  className="mt-1.5 rounded-md"
                  placeholder="engineer@example.com" />
              </div>
              <div>
                <Label htmlFor="invite_role">Role</Label>
                <select id="invite_role" value={role}
                  onChange={(e) => setRole(e.target.value as TeamMember['role'])}
                  className="mt-1.5 w-full border border-slate-800 rounded-md h-10 px-3 text-sm bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2">
                  <option value="developer">Developer — can create projects & deploy</option>
                  <option value="viewer">Viewer — read-only access</option>
                  <option value="admin">Admin — manage nodes, team & deployments</option>
                  <option value="owner">Owner — full access</option>
                </select>
              </div>
              <Button onClick={() => void inviteMember()}
                disabled={inviting || offlineMode || !orgId || !email.trim() || !canManageTeam}
                className="w-full bg-red-700 text-white hover:bg-red-800 rounded-md">
                {inviting ? 'Sending invite…' : offlineMode ? 'Server offline' : !canManageTeam ? 'No permission to invite' : 'Send Invite'}
              </Button>
            </CardContent>
          </Card>

          {/* GitHub Connections */}
          <Card className="electron-card rounded-xl shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">GitHub Application Connections</CardTitle>
              <CardDescription>Connect a managed GitHub application account so WatchTower can securely sync repositories.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {context?.github_connection?.connected ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <p className="text-xs font-medium text-emerald-800">
                    Connected as @{context.github_connection.github_username || 'github-user'}
                  </p>
                  <p className="text-[11px] text-emerald-700 mt-0.5">
                    Provider: {context.github_connection.provider === 'github_enterprise' ? 'GitHub Enterprise' : 'GitHub.com'}
                  </p>
                </div>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="text-xs font-medium text-amber-800">No managed GitHub application is connected yet.</p>
                  <p className="text-[11px] text-amber-700 mt-0.5">Connect one now to keep repository access managed and auditable.</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => void startOAuth('github_com')}
                  disabled={loading || !orgId || offlineMode}
                  className="bg-red-700 text-white hover:bg-red-800 rounded-md text-sm">
                  Connect GitHub.com App
                </Button>
                <Button onClick={() => void startOAuth('github_enterprise')}
                  disabled={loading || !orgId || offlineMode}
                  variant="outline" className="text-sm">
                  Connect Enterprise App
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
                  <div key={conn.id} className="electron-card-solid rounded-md px-3 py-2.5 flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900 truncate" title={`@${conn.github_username}`}>@{conn.github_username}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {conn.provider === 'github_enterprise' ? (conn.enterprise_name ?? 'GitHub Enterprise') : 'GitHub.com'}
                        {conn.is_primary && <span className="ml-2 text-blue-600">· Primary</span>}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 border rounded-full shrink-0 ${conn.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-100 text-gray-400 border-gray-200'}`}>
                      {conn.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Members list */}
        <Card className="electron-card rounded-xl shadow-none">
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
                const isCurrentUser = member.email === currentUserEmail;
                const canEdit = canManageTeam && !isCurrentUser;
                return (
                  <div key={member.id} className={`electron-card-solid rounded-md px-4 py-3 flex items-center justify-between gap-3 ${isCurrentUser ? 'ring-1 ring-blue-200' : ''}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-900 truncate" title={member.email}>{member.email}</p>
                        {isCurrentUser && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-700 shrink-0">You</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {canEdit ? (
                          <select
                            value={member.role}
                            onChange={(e) => void updateMemberRole(member.id, e.target.value as TeamMember['role'])}
                            disabled={updatingMember === member.id}
                            className={`text-xs border rounded-full px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-red-600 disabled:opacity-50 ${roleMeta.color}`}
                          >
                            {(['owner', 'admin', 'developer', 'viewer'] as TeamMember['role'][]).map((r) => (
                              <option key={r} value={r}>{ROLE_META[r].label}</option>
                            ))}
                          </select>
                        ) : (
                          <span className={`text-xs px-2 py-0.5 border rounded-full ${roleMeta.color}`}>{roleMeta.label}</span>
                        )}
                        {member.can_create_projects && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-500">Projects</span>
                        )}
                        {member.can_manage_deployments && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-500">Deploy</span>
                        )}
                        {member.can_manage_nodes && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-500">Nodes</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs px-2 py-0.5 border rounded-full ${member.is_active ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                        {member.is_active ? 'Active' : 'Inactive'}
                      </span>
                      {canEdit && member.is_active && (
                        <button
                          onClick={() => void deactivateMember(member.id, member.email)}
                          disabled={removingMember === member.id}
                          className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                        >
                          {removingMember === member.id ? '…' : 'Remove'}
                        </button>
                      )}
                    </div>
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
