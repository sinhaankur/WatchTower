# WatchTower Enterprise Features

## Overview

WatchTower supports multi-user collaboration with granular permissions, GitHub Enterprise integration, and a managed deployment node network for distributed infrastructure.

## Architecture

### Multi-Tenant Isolation

All resources are isolated at the **organization level** using `org_id`:

```
User (can belong to multiple orgs) 
  ├── Organization (workspace, team namespace)
  │   ├── Project (owned by org)
  │   ├── TeamMember (user + org + permissions)
  │   ├── GitHubConnection (org's GitHub/Enterprise account)
  │   └── OrgNode (managed deployment nodes)
  │       ├── NodeNetwork (logical grouping)
  │       └── Deployment (tracked to specific node)
```

**Key Principle:** Database-level org_id on every resource prevents cross-org data leaks.

---

## 1. Team Collaboration

### User Model Structure

```
User
├── id (PK)
├── email (unique)
├── github_username
├── github_id
└── created_at
```

Users can belong to **multiple organizations** via the `TeamMember` join table.

### TeamMember Model

```
TeamMember
├── id (PK)
├── user_id (FK → User)
├── organization_id (FK → Organization)
├── role (owner | admin | developer | viewer)
├── can_manage_nodes (boolean)
├── can_manage_team (boolean)
├── can_manage_projects (boolean)
├── can_trigger_deployments (boolean)
├── can_view_logs (boolean)
└── created_at
```

### Role-Based Access Control (RBAC)

| Role | Can Create Projects | Can Deploy | Can Manage Team | Can Manage Nodes | Can View Logs |
|------|:---:|:---:|:---:|:---:|:---:|
| **Owner** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Developer** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Viewer** | ❌ | ❌ | ❌ | ❌ | ✅ |

**Granular Flags** (added on top of base role):
- `can_manage_nodes` - Register and manage deployment nodes
- `can_manage_team` - Invite and remove team members
- `can_manage_projects` - Create/delete projects
- `can_trigger_deployments` - Start deployment processes
- `can_view_logs` - View build and deployment logs

### Team Management API

#### Invite Team Member

```http
POST /api/orgs/{org_id}/team-members
Content-Type: application/json
Authorization: Bearer {token}

{
  "email": "user@example.com",
  "role": "developer",
  "permissions": {
    "can_manage_nodes": false,
    "can_trigger_deployments": true,
    "can_view_logs": true
  }
}

Response: 201 Created
{
  "id": "tm_abc123",
  "user_id": "usr_123",
  "organization_id": "org_456",
  "role": "developer",
  "can_manage_nodes": false,
  "can_trigger_deployments": true,
  "can_view_logs": true,
  "created_at": "2024-01-15T10:30:00Z"
}
```

#### List Team Members

```http
GET /api/orgs/{org_id}/team-members
Authorization: Bearer {token}

Response: 200 OK
{
  "members": [
    {
      "id": "tm_abc123",
      "user": { "email": "dev@example.com", "github_username": "devuser" },
      "role": "developer",
      "can_manage_nodes": false,
      "joined_at": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 5,
  "total_admins": 2
}
```

#### Update Member Permissions

```http
PATCH /api/orgs/{org_id}/team-members/{member_id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "role": "admin",
  "can_manage_nodes": true
}

Response: 200 OK
```

#### Remove Team Member

```http
DELETE /api/orgs/{org_id}/team-members/{member_id}
Authorization: Bearer {token}

Response: 204 No Content
```

---

## 2. GitHub Enterprise Integration

### GitHubConnection Model

```
GitHubConnection
├── id (PK)
├── organization_id (FK → Organization)
├── provider (github_com | github_enterprise)
├── enterprise_url (string, nullable) → e.g., https://github.enterprise.com
├── github_access_token (encrypted)
├── github_account_id
├── repositories_synced (boolean)
└── created_at
```

### Supported Providers

#### GitHub.com (Public SaaS)
```python
GitHubProvider.GITHUB_COM
provider: "github_com"
enterprise_url: None
```

#### GitHub Enterprise (Self-Hosted)
```python
GitHubProvider.GITHUB_ENTERPRISE
provider: "github_enterprise"
enterprise_url: "https://github.enterprise.yourcompany.com"
```

### GitHub Connection API

#### Add GitHub Connection

```http
POST /api/orgs/{org_id}/github-connections
Content-Type: application/json
Authorization: Bearer {token}

{
  "provider": "github_enterprise",
  "enterprise_url": "https://github.enterprise.com",
  "github_access_token": "ghp_XXXXXXXXXXXXXX"
}

Response: 201 Created
{
  "id": "ghconn_abc123",
  "organization_id": "org_456",
  "provider": "github_enterprise",
  "enterprise_url": "https://github.enterprise.com",
  "github_account_id": "12345",
  "repositories_synced": false,
  "created_at": "2024-01-15T10:30:00Z"
}
```

#### List GitHub Connections

```http
GET /api/orgs/{org_id}/github-connections
Authorization: Bearer {token}

Response: 200 OK
{
  "connections": [
    {
      "id": "ghconn_abc123",
      "provider": "github_enterprise",
      "enterprise_url": "https://github.enterprise.com",
      "account_id": "12345",
      "repos_synced": 42,
      "created_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "ghconn_def456",
      "provider": "github_com",
      "enterprise_url": null,
      "account_id": "67890",
      "repos_synced": 8,
      "created_at": "2024-01-16T14:20:00Z"
    }
  ]
}
```

#### Update GitHub Connection

```http
PATCH /api/orgs/{org_id}/github-connections/{connection_id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "github_access_token": "ghp_NEWTOKENXXXXX"
}

Response: 200 OK
```

#### Delete GitHub Connection

```http
DELETE /api/orgs/{org_id}/github-connections/{connection_id}
Authorization: Bearer {token}

Response: 204 No Content
```

---

## 3. Deployment Node Management

### OrgNode Model (Managed Infrastructure)

```
OrgNode
├── id (PK)
├── organization_id (FK → Organization)
├── name (string) → "production-server-1"
├── hostname (string) → "prod1.infra.local"
├── port (integer) → 22 for SSH
├── status (healthy | unhealthy | offline)
├── cpu_usage (float) → 0-100%
├── memory_usage (float) → 0-100%
├── disk_usage (float) → 0-100%
├── last_health_check (datetime)
├── max_concurrent_builds (integer) → default 2
└── created_at
```

### Node Status Lifecycle

```
HEALTHY (online, responding to health checks)
    ↓ (3 failed checks)
UNHEALTHY (online but degraded)
    ↓ (continuous failed checks)
OFFLINE (unreachable)
    ↓ (manual recovery, health check passes)
HEALTHY
```

### Node Management API

#### Register Deployment Node

```http
POST /api/orgs/{org_id}/nodes
Content-Type: application/json
Authorization: Bearer {token}

{
  "name": "production-server-1",
  "hostname": "prod1.infra.local",
  "port": 22,
  "max_concurrent_builds": 2
}

Response: 201 Created
{
  "id": "node_xyz789",
  "organization_id": "org_456",
  "name": "production-server-1",
  "hostname": "prod1.infra.local",
  "port": 22,
  "status": "offline",
  "cpu_usage": 0,
  "memory_usage": 0,
  "disk_usage": 0,
  "last_health_check": null,
  "max_concurrent_builds": 2,
  "created_at": "2024-01-15T10:30:00Z"
}
```

#### List Organization Nodes

```http
GET /api/orgs/{org_id}/nodes
Authorization: Bearer {token}

Response: 200 OK
{
  "nodes": [
    {
      "id": "node_xyz789",
      "name": "production-server-1",
      "hostname": "prod1.infra.local",
      "status": "healthy",
      "cpu_usage": 45.2,
      "memory_usage": 62.1,
      "disk_usage": 78.5,
      "last_health_check": "2024-01-15T14:22:00Z"
    }
  ],
  "total": 3,
  "healthy_count": 2,
  "offline_count": 1
}
```

#### Check Node Health

```http
POST /api/orgs/{org_id}/nodes/{node_id}/health-check
Authorization: Bearer {token}

Response: 200 OK
{
  "status": "healthy",
  "cpu_usage": 45.2,
  "memory_usage": 62.1,
  "disk_usage": 78.5,
  "uptime": "45 days 12 hours",
  "last_check": "2024-01-15T14:22:00Z"
}
```

#### Update Node

```http
PATCH /api/orgs/{org_id}/nodes/{node_id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "max_concurrent_builds": 4
}

Response: 200 OK
```

#### Remove Node

```http
DELETE /api/orgs/{org_id}/nodes/{node_id}
Authorization: Bearer {token}

Response: 204 No Content
```

---

## 4. Node Networks (Logical Grouping)

### NodeNetwork Model

```
NodeNetwork
├── id (PK)
├── organization_id (FK → Organization)
├── name (string) → "production", "staging", "dev-team-alpha"
├── description (string)
├── environment (production | staging | development)
├── load_balance (boolean) → distribute builds across nodes
├── health_check_interval (integer) → seconds, default 60
├── created_at
```

### NodeNetworkMember Model (Association)

```
NodeNetworkMember
├── id (PK)
├── network_id (FK → NodeNetwork)
├── node_id (FK → OrgNode)
├── priority (integer) → 1-10, higher = preferred
├── weight (float) → for load balancing distribution
├── added_at
```

### Node Network Use Cases

#### 1. Environment Segmentation
```
production-network
├── prod-node-1 (priority: 10)
├── prod-node-2 (priority: 10)
└── prod-node-3 (priority: 5, fallback)

staging-network
├── staging-node-1 (priority: 10)
└── staging-node-2 (priority: 10)

development-network
├── dev-node-1 (priority: 10)
```

#### 2. Team-Based Routing
```
frontend-team-network
├── frontend-build-server (priority: 10)
└── frontend-backup-server (priority: 5)

backend-team-network
├── api-build-1 (priority: 10)
├── api-build-2 (priority: 10)
└── api-build-3 (priority: 5)
```

#### 3. Load Balanced Cluster
```
primary-cluster (load_balance: true)
├── node-1 (weight: 30%)
├── node-2 (weight: 30%)
├── node-3 (weight: 25%)
└── node-4 (weight: 15%)
```

### Node Network API

#### Create Node Network

```http
POST /api/orgs/{org_id}/node-networks
Content-Type: application/json
Authorization: Bearer {token}

{
  "name": "production",
  "description": "Production deployment infrastructure",
  "environment": "production",
  "load_balance": true,
  "health_check_interval": 60
}

Response: 201 Created
{
  "id": "net_prod123",
  "organization_id": "org_456",
  "name": "production",
  "description": "Production deployment infrastructure",
  "environment": "production",
  "load_balance": true,
  "health_check_interval": 60,
  "created_at": "2024-01-15T10:30:00Z"
}
```

#### Add Node to Network

```http
POST /api/orgs/{org_id}/node-networks/{network_id}/nodes
Content-Type: application/json
Authorization: Bearer {token}

{
  "node_id": "node_xyz789",
  "priority": 10,
  "weight": 30
}

Response: 201 Created
{
  "id": "member_abc123",
  "network_id": "net_prod123",
  "node_id": "node_xyz789",
  "priority": 10,
  "weight": 30,
  "added_at": "2024-01-15T10:30:00Z"
}
```

#### List Network Nodes

```http
GET /api/orgs/{org_id}/node-networks/{network_id}/nodes
Authorization: Bearer {token}

Response: 200 OK
{
  "network": {
    "id": "net_prod123",
    "name": "production",
    "load_balance": true
  },
  "nodes": [
    {
      "id": "node_xyz789",
      "name": "production-server-1",
      "status": "healthy",
      "priority": 10,
      "weight": 30,
      "cpu_usage": 45.2
    }
  ],
  "total": 3,
  "healthy_count": 3
}
```

#### Update Node Network

```http
PATCH /api/orgs/{org_id}/node-networks/{network_id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "load_balance": false,
  "health_check_interval": 120
}

Response: 200 OK
```

#### Remove Node from Network

```http
DELETE /api/orgs/{org_id}/node-networks/{network_id}/nodes/{node_id}
Authorization: Bearer {token}

Response: 204 No Content
```

#### Delete Node Network

```http
DELETE /api/orgs/{org_id}/node-networks/{network_id}
Authorization: Bearer {token}

Response: 204 No Content
```

---

## 5. Deployment Routing

### DeploymentNode Model

```
DeploymentNode
├── id (PK)
├── deployment_id (FK → Deployment)
├── node_id (FK → OrgNode)
├── network_id (FK → NodeNetwork)
├── assigned_at
```

### Deployment Node Assignment Flow

```
1. User triggers deployment
   ├── Selects: Project + Node Network (optional)
   │
2. System evaluates:
   ├── IF node_network specified
   │   ├── IF load_balance enabled
   │   │   └── Select node by weight (30% / 30% / 25% / 15%)
   │   └── ELSE
   │       └── Select highest priority healthy node
   └── ELSE
       └── Select from all org nodes (health priority)

3. Create Deployment with assigned node
   └── Build runs on selected node

4. Track:
   ├── Which network deployed to
   ├── Which node executed
   └── Execution metrics per node
```

### Deployment Selection Logic

```python
# Pseudocode for node selection

def select_node_for_deployment(network_id, org_id):
    if network_id:
        network = get_network(network_id, org_id)
        members = get_network_members(network_id)
        
        healthy = [m for m in members if m.node.status == HEALTHY]
        
        if network.load_balance:
            # Select by weighted probability
            return weighted_random_choice(healthy, weights=[m.weight for m in healthy])
        else:
            # Select by priority
            return sorted(healthy, key=lambda m: m.priority, reverse=True)[0]
    else:
        # Select from all org nodes
        all_nodes = get_org_nodes(org_id)
        healthy = [n for n in all_nodes if n.status == HEALTHY]
        return sorted(healthy, key=lambda n: n.cpu_usage)[0]  # Lowest CPU load
```

---

## 6. Permission Checks (Authorization)

Every enterprise endpoint includes permission validation:

```python
# Example permission check in FastAPI

@router.post("/orgs/{org_id}/team-members")
async def invite_team_member(org_id: str, db: Session, token: str):
    # 1. Get current user from token
    user = verify_token(token)
    
    # 2. Check if user in org
    member = db.query(TeamMember).filter(
        TeamMember.user_id == user.id,
        TeamMember.organization_id == org_id
    ).first()
    
    if not member:
        raise HTTPException(403, "Not member of organization")
    
    # 3. Check specific permission
    if not member.can_manage_team:
        raise HTTPException(403, "No permission to manage team")
    
    # 4. Check role fallback
    if member.role not in [TeamRole.OWNER, TeamRole.ADMIN]:
        raise HTTPException(403, "Only admins can manage team")
    
    # 5. Proceed with operation
    ...
```

---

## 7. Frontend Integration

### Setup Wizard Enhancement (Step 4 - Enterprise)

When user selects "Team Setup" in wizard:

**New Step 4a: GitHub Connection**
```
Select GitHub Provider:
  ○ GitHub.com (Public)
  ○ GitHub Enterprise (Self-hosted) → requires: enterprise_url
  
GitHub Access Token: ________________
[Verify Connection]
```

**New Step 4b: Team Members**
```
Add initial team members:
[+ Add Team Member]

Name | Email | Role | Invite
```

**New Step 4c: Deployment Nodes (Optional)**
```
Add deployment infrastructure:
[+ Register Node]

Node Name | Hostname | Status | Health
```

**New Step 4d: Node Networks**
```
Create node networks:
[+ Create Network]

Network | Environment | Nodes | Load Balance
```

### Dashboard Enhancements

**1. Team Panel**
```
Team Members (5)
├── Owner: you@example.com
├── Admin: admin@example.com
├── Developer: dev1@example.com (2 more)
└── [+ Invite Member]
```

**2. Infrastructure Panel**
```
Deployment Nodes (3)
├── production-1 (healthy, 45% CPU)
├── production-2 (healthy, 62% CPU)
├── staging-1 (offline)
└── [+ Register Node]

Node Networks (2)
├── Production (3 nodes, load balanced)
├── Staging (2 nodes, priority based)
└── [+ Create Network]
```

**3. GitHub Connections Panel**
```
Connected Accounts (2)
├── github.com (42 repos, synced)
├── github.enterprise.com (18 repos, synced)
└── [+ Add Connection]
```

---

## 8. Security Considerations

### Token Storage

**GitHub Access Tokens:**
- Stored encrypted in database using `cryptography` library
- Never exposed in API responses
- Rotated on update
- Scoped to minimum permissions (repo access only)

### Multi-Tenant Isolation

**Database Level:**
- All resources have `organization_id` foreign key
- Queries ALWAYS filter by org_id
- No cross-org data leaks possible

**API Level:**
- Token includes org_id claim
- Verify org_id matches resource org_id
- Explicit permission check per operation

### Permission System

**Granular Controls:**
- Role-based ceiling (owner > admin > developer > viewer)
- Boolean flags override role (admin without can_manage_nodes)
- Deny-by-default (must explicitly grant permission)

### Node Communication

**SSH Authentication:**
- Public key distribution to nodes
- No password auth
- Key rotated periodically
- Health checks over SSH

---

## 9. Deployment Workflow with Nodes

### Full Deployment Pipeline

```
1. User: Trigger Deployment
   └── API: POST /api/projects/{project_id}/deployments
       ├── select_node_network() → "production"
       └── select_node_in_network() → "prod-1"

2. System: Create Deployment Record
   └── DB: Deployment + DeploymentNode link
       ├── status: QUEUED
       ├── node_id: prod-1
       └── network_id: production

3. Build System: Clone & Build
   ├── SSH to prod-1
   ├── Clone repo from GitHub (using GitHubConnection)
   ├── Run build command (from Project config)
   └── Generate build artifact

4. Build System: Deploy
   ├── Move artifact to deployment dir
   ├── Reload service (systemd/docker restart)
   └── Update: status RUNNING

5. Health Check (continuous)
   ├── Verify service healthy
   ├── Monitor logs
   ├── Update: status SUCCESS/FAILED

6. Rollback (if needed)
   └── Re-deploy previous build to same node
```

---

## 10. Implementation Checklist

### Phase 1: Core Enterprise (Week 1)
- [x] Database schema (16 tables)
- [x] Schemas & validators (enterprise_schemas.py)
- [x] Team management API
- [x] GitHub connection API
- [x] Node management API
- [ ] Node network API (implementation ready)
- [ ] Permission checks & middleware
- [ ] GitHub OAuth implementation

### Phase 2: Frontend (Week 2)
- [ ] Team management UI
- [ ] Node management UI
- [ ] GitHub connection UI
- [ ] Node network configuration UI
- [ ] Enterprise setup wizard steps

### Phase 3: Integration (Week 3)
- [ ] Deploy on selected node
- [ ] Node health checks (SSH)
- [ ] Load balancing algorithm
- [ ] Deployment node tracking

### Phase 4: Polish (Week 4)
- [ ] Error handling & retries
- [ ] Monitoring & alerting
- [ ] Documentation & guides
- [ ] Test coverage

---

## 11. Example Workflows

### Workflow A: Multi-Team SaaS

**Organization Structure:**
```
Company XYZ (Org)
├── Frontend Team (NodeNetwork)
│   ├── frontend-build-1 (CPU optimized)
│   └── frontend-build-2 (CPU optimized)
└── Backend Team (NodeNetwork)
    ├── api-build-1 (Memory optimized)
    └── api-build-2 (Memory optimized)
```

**Members:**
- Owner: founder@xyz.com
- Admin (Backend): eng-lead@xyz.com
  - can_manage_nodes: true
  - can_manage_team: true
- Developer: dev1@xyz.com
  - can_manage_nodes: false
  - can_trigger_deployments: true

### Workflow B: Self-Hosted Enterprise

**Organization Structure:**
```
Enterprise Corp (Org)
├── GitHub.com (public repos)
└── GitHub Enterprise (private repos) → https://github.enterprise.corp.com
    └── Production Network
        ├── prod-us-east (primary)
        ├── prod-us-west (failover)
        └── prod-eu (regional)
```

**Members:**
- Owner: platform-team@corp.com
- DevOps Admin: ops@corp.com
  - can_manage_nodes: true
- Release Manager: release@corp.com
  - can_trigger_deployments: true

---

## 12. Monitoring & Observability

### Metrics to Track

**Node Metrics:**
- CPU usage trend (per node)
- Memory usage trend (per node)
- Disk usage trend (per node)
- Health check frequency
- Downtime duration

**Deployment Metrics:**
- Deployments per node (distribution)
- Deployment success rate per node
- Average build time per node
- Failed deployments by node

**Team Metrics:**
- Active members per org
- Deployments per member
- Permission distribution

### Alerting Rules

```
✓ Node CPU > 90% for 5 min → alert
✓ Node offline > 15 min → alert
✓ Network all nodes offline → critical alert
✓ Failed deployment > 3 in row → alert
✓ Team member removed → log event
```

---

## Next Steps

1. **Implement GitHub OAuth** - Support both github.com and enterprise instances
2. **Build Frontend UI** - Team, node, and network management pages
3. **Add Node Health Checks** - SSH integration for remote monitoring
4. **Load Balancing Algorithm** - Implement weighted selection
5. **Deployment Integration** - Route builds to selected nodes
6. **Testing & Documentation** - Write integration tests and user guides

