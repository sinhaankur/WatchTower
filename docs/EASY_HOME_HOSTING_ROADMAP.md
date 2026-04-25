# WatchTower: Easy Home Hosting & Mesh Network Roadmap

## 🎯 CORE VISION
**Make it dead simple for users to host websites from their PC without expertise, while enabling a distributed peer-to-peer mesh network with optimized throughput.**

---

## ✅ WHAT'S ALREADY WORKING

### 1. **Simple PC Registration** ✓
- `LocalNode.tsx` - "Use This PC as Server" one-click setup
- Auto-detect OS (Linux/macOS/Windows)
- Smart resource profiles (Light/Standard/Full)
- Auto-populate deploy paths & service names
- Skip confirmation checkbox for quick setup

**Status:** Live (commit 1e35c86)

### 2. **Node Management** ✓
- SSH connectivity check (health monitoring)
- Multiple nodes per organization
- Node status tracking (HEALTHY/UNREACHABLE)
- Remote deployment via SSH

**Status:** Live

### 3. **Quick-Start Setup Wizards** ✓
- Setup Wizard with smart presets
- GitHub repo auto-detection
- Build command templates
- Project creation in 3 steps for new users

**Status:** Live (commit 1e35c86)

### 4. **Custom Domain Support** ✓
- Database schema for custom domains
- TLS/Let's Encrypt validation support
- Primary domain designation
- Domain routing in reverse proxy (Caddy)

**Status:** Schema ready, UI/API partially implemented

### 5. **Node Networks (Mesh Infrastructure)** ✓
- `NodeNetwork` model for grouping nodes
- `NodeNetworkMember` with priority/weight for load balancing
- Health check intervals configurable
- Load balancing flag (distribute across nodes)

**Status:** Database & API ready, UI needs implementation

### 6. **Mesh Deployment Setup** ✓
- `docker-compose.mesh.yml` with Caddy
- Multi-node Caddy configuration files
- Upstream management
- Let's Encrypt ACME for TLS across mesh

**Status:** Docker-ready, needs orchestration UI

---

## 🚀 NEAR-TERM PRIORITIES (1-2 weeks)

### 1. **Domain Management UI** (HIGH PRIORITY)
**Goal:** Make domain connection trivial for users

#### Phase 1A: Domain Registration Interface
```
Path: /projects/{id}/domains

UI Components:
├── "Add Domain" modal
│   ├── Domain name input
│   ├── Auto-detect DNS provider (GoDaddy, Cloudflare, etc.)
│   ├── TLS option (Auto Let's Encrypt / Manual cert)
│   └── "Point these nameservers" instructions
├── Domain list
│   ├── Show each domain's status
│   ├── DNS validation progress
│   ├── TLS cert expiry countdown
│   └── "Test domain" button
└── DNS helper
    ├── Step-by-step copy/paste instructions
    ├── "Check DNS propagation" tool
    └── Common provider quick-links
```

#### Phase 1B: API Endpoints
```python
POST /projects/{project_id}/domains
  - Register custom domain
  - Generate DNS validation records
  - Trigger Let's Encrypt validation

GET /projects/{project_id}/domains
  - List domains
  - Show DNS status, TLS status

DELETE /projects/{project_id}/domains/{domain_id}
  - Remove domain

POST /projects/{project_id}/domains/{domain_id}/validate-dns
  - Trigger DNS validation check
  - Refresh TLS cert status
```

#### Phase 1C: Database Updates
```python
# Already exists, add:
CustomDomain:
  + dns_provider: str (optional, for provider detection)
  + dns_records: JSON (TXT records for validation)
  + dns_validated_at: datetime
  + next_renewal: datetime (for TLS certs)
```

### 2. **Mesh Network UI** (HIGH PRIORITY)
**Goal:** Make it easy to create distributed networks

#### Phase 2A: Network Creation UI
```
Path: /networks  (new page)

UI Components:
├── "Create Network" card
│   ├── Network name (e.g., "Production", "Team Alpha")
│   ├── Network type
│   │   ├── "Distributed Mesh" (peer-to-peer with sync)
│   │   ├── "Load Balanced" (round-robin)
│   │   └── "Geographic" (closest node)
│   └── Select nodes to join
├── Network list
│   ├── Network status dashboard
│   ├── Node membership with weights
│   ├── Traffic distribution chart
│   ├── Latency/throughput metrics
│   └── "Add node to network" button
└── Network settings
    ├── Health check interval
    ├── Failover strategy
    └── Load balancing algorithm
```

#### Phase 2B: Node Network Endpoints (Already have basic schema)
```python
# Existing endpoints:
GET /orgs/{org_id}/node-networks          ✓
POST /orgs/{org_id}/node-networks         ✓
POST /node-networks/{network_id}/nodes    ✓

# Need to add:
PUT /node-networks/{network_id}
  - Update load balance strategy
  - Adjust health check interval

DELETE /node-networks/{network_id}

GET /node-networks/{network_id}/status
  - Real-time node health
  - Network throughput
  - Traffic distribution

POST /node-networks/{network_id}/nodes/{node_id}
  - Add node with specific weight

PUT /node-networks/{network_id}/nodes/{node_id}
  - Update node weight/priority for load balancing

DELETE /node-networks/{network_id}/nodes/{node_id}
  - Remove node from network
```

#### Phase 2C: Mesh Orchestration Service
```python
# New service: watchtower/mesh_orchestrator.py

class MeshOrchestrator:
    """
    Manages peer-to-peer communication between nodes
    Optimizes throughput based on latency & bandwidth
    """
    
    async def discover_nodes(network_id: UUID):
        """Detect available nodes in network"""
    
    async def measure_latency(node_a, node_b) -> int:
        """Measure RTT between nodes"""
    
    async def measure_bandwidth(node_a, node_b) -> float:
        """Measure throughput between nodes"""
    
    async def sync_deployments(network_id, nodes):
        """Sync deployment configs across mesh"""
    
    async def optimize_routes(network_id):
        """Find optimal peer-to-peer routes for throughput"""
        # Inspired by IEEE peer-to-peer transfer optimization
        # Build graph of nodes + latencies
        # Find shortest/fastest paths for deployment propagation
```

---

## 🔄 MEDIUM-TERM (2-4 weeks)

### 3. **Automatic DNS Provider Integration**

**Goal:** Zero-config domain setup — point domain, we handle rest

```python
# watchtower/api/dns_providers.py

class DNSProvider:
    """Abstract base for DNS providers"""
    
    async def create_dns_record(domain, record_type, value):
        """Auto-create DNS records for validation"""
    
    async def validate_ownership():
        """Verify domain ownership"""

# Implementations:
class CloudflareDNS(DNSProvider):
    """Cloudflare API integration"""

class Route53DNS(DNSProvider):
    """AWS Route53 integration"""

class GoDaddyDNS(DNSProvider):
    """GoDaddy API integration"""

# Usage: Users paste API key, we auto-configure DNS + TLS
```

### 4. **Peer-to-Peer Deployment Sync**

**Goal:** Deploy once, auto-sync across mesh network

```python
# watchtower/mesh/deployment_sync.py

class MeshDeploymentSync:
    """
    IEEE-optimized peer-to-peer transfer
    - Measure latencies between all node pairs
    - Build routing graph
    - Distribute deployment artifacts along fastest paths
    - Monitor throughput, adapt routing
    """
    
    async def deploy_to_mesh(deployment_id, network_id):
        """
        1. Upload to primary node
        2. Measure peer latencies
        3. Calculate optimal distribution routes
        4. Sync to all nodes in parallel along fastest paths
        5. Verify all nodes have deployment
        """
    
    async def measure_mesh_health():
        """Continuous latency/bandwidth monitoring"""
    
    async def optimize_mesh_topology():
        """Adjust routes if latencies change"""
```

### 5. **One-Click Install Script** (Enhancement)

**Goal:** From repo → running website on PC in < 5 minutes

```bash
# Single command installation
curl -fsSL https://get.watchtower.sh | bash -s -- \
  --preset home \           # Preset for home users
  --domain example.com \    # Auto-setup domain
  --os auto \              # Detect OS
  --profile standard       # Resource profile

# What this does:
# 1. Install WatchTower agent (Linux service / macOS LaunchAgent / Windows service)
# 2. Register PC as node in user's org
# 3. Copy domain setup instructions
# 4. Create network if needed
# 5. Open browser to setup page
```

---

## 🌍 LONG-TERM (1-3 months)

### 6. **Public Mesh Discovery**

**Goal:** Build a marketplace where users can share compute capacity

```
┌────────────────────────────────────┐
│ WatchTower Mesh Marketplace        │
├────────────────────────────────────┤
│ Available Nodes:                   │
│ • john-pc (Linux) - 2 cores, 8GB  │
│ • emily-mac (macOS) - 4 cores, 16GB
│ • server-1 (Ubuntu) - 8 cores, 32GB
│                                   │
│ → User can subscribe to network   │
│ → Pay per deployment usage (micro) │
└────────────────────────────────────┘
```

### 7. **Advanced Mesh Features**

- **Geographic distribution**: Route to closest node
- **Throughput optimization**: ML-based route learning
- **Automatic failover**: Detect node failure, reroute
- **Cost optimization**: Pick cheapest available nodes
- **Privacy**: End-to-end encryption for deployments

---

## 📋 IMPLEMENTATION CHECKLIST

### Phase 1: Domain Management (Week 1-2)
- [ ] Create `/projects/{id}/domains` UI page
- [ ] "Add Domain" modal with DNS instructions
- [ ] Domain status dashboard (validation, TLS, expiry)
- [ ] Implement missing API endpoints for domain CRUD
- [ ] DNS validation loop (check propagation every 30s)
- [ ] Let's Encrypt integration (auto-renewal 30 days before expiry)
- [ ] Generate DNS TXT records for validation

### Phase 2: Mesh Network UI (Week 2-3)
- [ ] Create `/networks` page (network list + dashboard)
- [ ] "Create Network" modal with node selection
- [ ] Network status display (health, traffic, latency)
- [ ] Update node-network API endpoints (missing PUT/DELETE)
- [ ] Real-time network health endpoint

### Phase 3: Mesh Orchestration (Week 3-4)
- [ ] `MeshOrchestrator` service
- [ ] Latency measurement between node pairs
- [ ] Bandwidth measurement
- [ ] Route optimization algorithm (IEEE-inspired)
- [ ] Mesh deployment sync service

### Phase 4: Advanced Features (Month 2+)
- [ ] Cloudflare/Route53 auto-DNS
- [ ] Public mesh marketplace UI
- [ ] Advanced failover strategies
- [ ] Cost & performance dashboards

---

## 🎨 UI/UX QUICK WINS

### 1. **Domain Setup Card on Project Page**
```
Current: User has to navigate to settings

Proposed: Show on main project page
┌─────────────────────────────────────┐
│ 🌐 Domain Setup                     │
│ app.example.com                     │
│ Status: ⏳ Validating DNS          │
│ [View Instructions] [Manage]        │
└─────────────────────────────────────┘
```

### 2. **Network Overview Dashboard**
```
┌──────────────────────────────────────┐
│ 📡 Production Network                │
├──────────────────────────────────────┤
│ Nodes: 3/3 healthy                   │
│ Avg latency: 15ms                    │
│ Last deployment: ✓ 2 min ago         │
│ [View Details]                       │
└──────────────────────────────────────┘
```

### 3. **Quick-Add Node to Network**
```
In network view:
[+ Add Node] button
  ↓
Modal: "Pick a node"
  ↓
Shows only unassigned nodes
  ↓
Set weight (traffic %)
  ↓
Done, node joins mesh
```

---

## 🔧 TECHNICAL ARCHITECTURE

```
WatchTower Platform (Easy Home Hosting)
│
├─ Frontend (React)
│  ├─ /projects → Domain management UI
│  ├─ /networks → Mesh network UI
│  └─ /servers → Node health & metrics
│
├─ Backend (FastAPI)
│  ├─ /api/projects/{id}/domains → Domain CRUD + DNS
│  ├─ /api/orgs/{id}/node-networks → Network CRUD
│  ├─ /api/node-networks/{id}/status → Health monitoring
│  └─ /api/deployments/{id}/sync-mesh → Mesh sync
│
├─ Services
│  ├─ MeshOrchestrator → Route optimization
│  ├─ DNSValidator → DNS propagation checks
│  ├─ CertManager → Let's Encrypt automation
│  ├─ DeploymentSync → Peer-to-peer propagation
│  └─ HealthMonitor → Node status & metrics
│
├─ Database
│  ├─ CustomDomain (schema ready ✓)
│  ├─ NodeNetwork (schema ready ✓)
│  ├─ NodeNetworkMember (schema ready ✓)
│  └─ MeshMetrics (new: latency, throughput, hops)
│
└─ Infrastructure
   ├─ Caddy (reverse proxy + TLS) ✓
   ├─ Podman (build runtime) ✓
   └─ Docker-compose.mesh.yml (orchestration) ✓
```

---

## 🎯 SUCCESS METRICS

**When complete, users should be able to:**

1. **Register PC in < 1 minute**
   - One click "Use This PC"
   - Auto-detect everything
   - Service runs automatically

2. **Add domain in < 5 minutes**
   - Copy/paste DNS records
   - Click "verify"
   - Auto TLS setup

3. **Create mesh network in < 2 minutes**
   - Click "Create Network"
   - Select nodes
   - Network active & synced

4. **Deploy to mesh in < 30 seconds**
   - Push to GitHub
   - Deploy happens across all nodes automatically
   - Zero additional config

---

## 💡 NOTES

- **IEEE Optimization:** The mesh orchestrator implements concepts from IEEE peer-to-peer transfer papers: latency measurement, throughput optimization, dynamic routing
- **No Vendor Lock-in:** Users own their data, control their nodes
- **Cost:** Self-hosted on user's hardware = no cloud costs
- **Privacy:** Deployments stay on user's network
- **Simplicity:** Everything optimized for new users

