# WatchTower Development: Quick Reference Guide

## 📚 Documentation Map

You now have these strategic documents:

### 1. **EASY_HOME_HOSTING_ROADMAP.md** ← Start here
- **What's it for?** High-level product vision
- **Contains:** 
  - What's already working (✓ quick wizard, ✓ node registration, etc.)
  - 4 implementation phases (1-2 weeks each)
  - Success metrics & long-term vision
- **Read time:** 10 minutes

### 2. **DOMAIN_IMPLEMENTATION_GUIDE.md** ← For Phase 1 (Domains)
- **What's it for?** Concrete implementation tasks for custom domains
- **Contains:**
  - UI component structure (DomainList, AddDomainModal, DNSHelper)
  - Complete backend API endpoints
  - Database schema updates
  - Service implementation (DomainService, CaddySyncService)
  - DNS validation loop algorithm
  - Testing checklist
- **Read time:** 15 minutes
- **Est. dev time:** 2-3 weeks

### 3. **MESH_IMPLEMENTATION_GUIDE.md** ← For Phase 2-3 (Mesh Networks)
- **What's it for?** IEEE peer-to-peer optimization for distributed PC networks
- **Contains:**
  - Network topology discovery algorithm
  - Latency & bandwidth measurement
  - Optimal routing tree algorithm (Prim's variant)
  - P2P deployment sync service
  - Mesh orchestration service design
  - Metrics & monitoring dashboard
- **Read time:** 20 minutes
- **Est. dev time:** 3-4 weeks

---

## 🚀 NEXT STEPS (Immediate)

### What to do RIGHT NOW:

1. **Review Roadmap** (5 min)
   ```
   docs/EASY_HOME_HOSTING_ROADMAP.md
   ↓
   Read the "What's Already Working" section
   Focus on what you need to build vs. what exists
   ```

2. **Pick Your First Task**
   
   **Option A: Build Domain Management UI** (2-3 weeks)
   - Good for: Understanding full stack (React → FastAPI → Caddy)
   - User impact: HIGH (immediate value - users can add custom domains)
   - Dependencies: None (schema already exists)
   - Doc: `DOMAIN_IMPLEMENTATION_GUIDE.md`
   
   **Option B: Build Mesh Network UI** (1-2 weeks for UI only)
   - Good for: Learning network visualization
   - User impact: MEDIUM (shows which nodes work together)
   - Dependencies: Needs basic orchestration service
   - Doc: `MESH_IMPLEMENTATION_GUIDE.md`
   
   **Option C: Implement Mesh Orchestration** (2-3 weeks)
   - Good for: Understanding peer-to-peer algorithms
   - User impact: HIGH (enables smart deployment sync)
   - Dependencies: Needs orchestration service running
   - Doc: `MESH_IMPLEMENTATION_GUIDE.md`

3. **Create Session Notes** (2 min)
   ```bash
   # Document your choice
   cat > /memories/session/current-task.md << 'EOF'
   # Current Task
   
   ## Decision
   Building: [Domain Management UI / Mesh UI / Mesh Orchestration]
   
   ## Why
   [Your reason]
   
   ## Timeline
   [Expected duration]
   EOF
   ```

---

## 🏗️ ARCHITECTURE QUICK REFERENCE

### Current Tech Stack
```
Frontend:  React + Vite (TypeScript)  → web/src/pages/
Backend:   FastAPI + SQLAlchemy       → watchtower/api/
Desktop:   Electron                   → desktop/
Database:  SQLAlchemy ORM             → watchtower/database.py
Proxy:     Caddy                      → config/caddy/ + docker-compose.mesh.yml
Packages:  npm (frontend), pip (backend)
```

### Data Models Ready to Use
```python
# All of these already exist in watchtower/database.py:
✓ CustomDomain         # For domain routing
✓ NodeNetwork          # For grouping nodes
✓ NodeNetworkMember    # For node membership + weight
✓ OrgNode              # For registered computers
✓ Project              # For apps
✓ Organization         # For teams
✓ TeamMember           # For team access control
```

### API Endpoints Ready
```python
# Node Networks (basic)
✓ GET    /orgs/{org_id}/node-networks
✓ POST   /orgs/{org_id}/node-networks
✓ POST   /node-networks/{network_id}/nodes

# Domains (schema ready, some endpoints missing)
⚠ GET    /projects/{project_id}/domains       → Need to implement
⚠ POST   /projects/{project_id}/domains       → Need to implement
⚠ DELETE /projects/{project_id}/domains/{id}  → Need to implement
```

### Frontend Components Ready
```tsx
✓ web/src/pages/SetupWizard.tsx      # Already has quickMode
✓ web/src/pages/LocalNode.tsx        # Already has autoRegister
✓ web/src/pages/Login.tsx            # GitHub OAuth prominent
⚠ web/src/pages/ProjectDetail.tsx    → Need tabs (Domains, Deployments, Settings)
⚠ web/src/components/DomainManager/  → Need to create
⚠ web/src/pages/NetworkList.tsx      → Need to create
```

---

## 💾 CODE ORGANIZATION

### If building Domain Management:

**Frontend files to create:**
```
web/src/pages/
  ├── ProjectDetail.tsx          (NEW - parent with tabs)
  └── components/
      └── DomainManager/         (NEW)
          ├── DomainList.tsx
          ├── AddDomainModal.tsx
          ├── DomainCard.tsx
          └── DNSHelper.tsx
```

**Backend files to create:**
```
watchtower/
  ├── services/
  │   ├── domain_service.py      (NEW - domain logic)
  │   └── caddy_sync_service.py  (NEW - sync to Caddy)
  ├── api/
  │   └── domains.py             (NEW - /api/projects/{id}/domains endpoints)
  └── migrations/
      └── add_domain_fields.py   (NEW - database schema updates)
```

### If building Mesh Network UI:

**Frontend files to create:**
```
web/src/pages/
  ├── NetworkList.tsx            (NEW - network index)
  ├── NetworkDetail.tsx          (NEW - single network view)
  └── components/
      └── NetworkBuilder/        (NEW)
          ├── CreateNetworkModal.tsx
          ├── NodeSelector.tsx
          ├── TrafficChart.tsx
          └── TopologyGraph.tsx
```

**Backend files to create:**
```
watchtower/
  ├── mesh/
  │   ├── orchestrator.py        (NEW - topology + routing)
  │   └── deployment_sync.py     (NEW - P2P sync)
  ├── services/
  │   └── network_service.py     (NEW - network CRUD)
  ├── api/
  │   └── networks.py            (NEW - endpoints)
  └── database.py                (UPDATE - add NetworkMetric model)
```

### If building Mesh Orchestration:

Use mesh orchestrator as described in `MESH_IMPLEMENTATION_GUIDE.md`.

---

## 🧪 LOCAL TESTING SETUP

### Prerequisites
```bash
# Install system deps (if needed)
# Python 3.12 + pip + Node 18+ + npm/yarn

# Backend setup
cd /path/to/WatchTower
pip install -r requirements.txt

# Frontend setup
cd web
npm install
npm run dev        # Starts on :5222

# In another terminal, start backend
cd /path/to/WatchTower
python -m watchtower.api  # Starts on :8000

# Electron desktop
cd desktop
npm install
npm start          # Runs both backend + frontend
```

### Database
```bash
# SQLite is used by default for local dev
# Database file: watchtower/database.db

# To reset:
rm watchtower/database.db
python -c "from watchtower.database import init_db; init_db()"
```

### Testing APIs Locally
```bash
# Get auth token
curl -X POST http://localhost:8000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'

# Use token in requests
curl -X GET http://localhost:8000/api/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 📝 COMMIT WORKFLOW

### Recent commits you can learn from:

```bash
# See what changed in previous work:
git log --oneline -n 5

# Review specific commits:
git show 6c75f10    # Permission backfill fix
git show 1e35c86    # Quick-start wizards
git show c2a99e69   # GitHub OAuth enhancement
```

### For your work:

```bash
# Create feature branch
git checkout -b feature/domain-management

# Make changes
git add .
git commit -m "feat: add domain UI + API endpoints"

# Push
git push origin feature/domain-management

# Create PR when ready
```

---

## 🎯 SUCCESS CHECKLIST FOR EACH PHASE

### Phase 1: Domain Management ✅ When done:
- [ ] Users can navigate to project → Domains tab
- [ ] "Add Domain" modal works
- [ ] DNS instructions display for user's registrar
- [ ] DNS validation runs in background
- [ ] TLS cert auto-requests via Let's Encrypt
- [ ] Domain shows up at https://example.com
- [ ] Users can see domain status + cert expiry
- [ ] Integration with Caddy reverse proxy works

### Phase 2: Mesh Network UI ✅ When done:
- [ ] Users see list of networks
- [ ] Can create new network + select nodes
- [ ] Network dashboard shows health + latency
- [ ] Can add/remove nodes from network
- [ ] Topology graph visualizes node connections
- [ ] Traffic distribution shows weight per node

### Phase 3: Mesh Orchestration ✅ When done:
- [ ] Deploy to mesh syncs to all nodes automatically
- [ ] Latency measured between node pairs
- [ ] Optimal routing tree calculated
- [ ] P2P sync uses fastest paths
- [ ] Deployment completes in < 1 minute across mesh
- [ ] Metrics dashboard shows sync times

---

## 🆘 TROUBLESHOOTING

### Common Issues

**Q: API endpoint returns 401 Unauthorized**
```
A: Check authentication
- Get token: curl -X POST http://localhost:8000/api/auth/token
- Include in header: -H "Authorization: Bearer TOKEN"
- Check token hasn't expired
```

**Q: Frontend can't reach backend**
```
A: Check proxy config
- Backend must be running on :8000
- Frontend (dev) running on :5222
- Check vite.config.ts has correct proxy settings
- Or use Electron (desktop/) which bundles both
```

**Q: Database migration fails**
```
A: Reset and reinitialize
- rm watchtower/database.db
- python -c "from watchtower.database import init_db; init_db()"
- Restart backend
```

**Q: npm build fails**
```
A: Clean install
- rm -rf web/node_modules
- npm install
- npm run build
```

---

## 📚 REFERENCE LINKS (In your codebase)

Key files to understand:

```
Authentication:
  watchtower/api/util.py                # get_current_user() + HMAC tokens

Existing APIs:
  watchtower/api/enterprise.py          # org/team/node management
  watchtower/api/__init__.py            # Router setup

Database:
  watchtower/database.py                # All ORM models

Frontend routing:
  web/src/App.tsx                       # Page routing
  web/src/api/apiClient.ts              # API client setup

Infrastructure:
  deploy/docker-compose.mesh.yml        # Multi-node deployment
  config/caddy/Caddyfile.mesh           # Reverse proxy config
```

---

## 💡 FINAL TIPS

1. **Start with what you know**: If you understand React better, start with Domain UI. If you prefer backend, start with Orchestration service.

2. **Use existing patterns**: Look at `SetupWizard.tsx` (1e35c86) to see how to structure multi-step flows.

3. **Test as you build**: Use local Electron app, add test users, verify API calls with curl.

4. **Document decisions**: When making architectural choices, add notes to `/memories/session/` so you remember why.

5. **Keep it simple first**: Get basic functionality working, then optimize/prettify.

---

## 🎬 GETTING STARTED RIGHT NOW

**Pick one and START:**

```bash
# Option 1: Domain Management (UI-first)
# 1. Read: docs/DOMAIN_IMPLEMENTATION_GUIDE.md
# 2. Create: web/src/pages/ProjectDetail.tsx
# 3. Create: web/src/components/DomainManager/DomainList.tsx
# 4. Wire it up to API

# Option 2: Mesh Network (UI + logic)
# 1. Read: docs/MESH_IMPLEMENTATION_GUIDE.md
# 2. Create: web/src/pages/NetworkList.tsx
# 3. Create: watchtower/mesh/orchestrator.py (Phase 2)
# 4. Test topology discovery

# Option 3: Mesh Orchestration (Backend-first)
# 1. Read: docs/MESH_IMPLEMENTATION_GUIDE.md Phases 2-3
# 2. Implement: watchtower/mesh/orchestrator.py
# 3. Implement: watchtower/mesh/deployment_sync.py
# 4. Write tests + integration
```

**Good luck! 🚀**

