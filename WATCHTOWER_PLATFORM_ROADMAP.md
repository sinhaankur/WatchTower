# WatchTower Platform Roadmap
## Unified Deployment Platform (Self-Hosted + SaaS)

---

## 1. VISION & SCOPE

**Mission:** Make WatchTower a flexible, unified deployment platform that can compete with Netlify, Vercel, and self-hosted solutions like Coolify.

**Key Features:**
- 🚀 **3 Use Cases** (user selectable):
  - **A) Netlify-like**: Static hosting + optional functions
  - **B) Vercel-like**: Next.js/SSR + API routes + previews
  - **C) Self-hosted Docker**: Deploy any containerized app
  
- 🔀 **2 Deployment Models** (user selectable):
  - **Self-Hosted**: Run WatchTower on your server, full control
  - **SaaS**: Cloud version, multi-tenant, GitHub auth
  
- 📊 **Dashboard**: Unified UI for all configurations
- 🔌 **Webhooks**: GitHub/GitLab push events auto-trigger builds
- 📦 **Build System**: Containerized build jobs (using Podman)
- 🔐 **Authentication**: GitHub OAuth (SaaS) + local users (self-hosted)

---

## 2. DEPLOYMENT MODEL DIFFERENCES

### Self-Hosted Mode
```
┌─────────────────────────────────────────────────────┐
│ User's Server (Docker/Podman host)                  │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ WatchTower Container                        │   │
│  │ ├─ Dashboard (React/FastAPI)               │   │
│  │ ├─ Build Runner (Podman)                   │   │
│  │ ├─ Webhook Listener                        │   │
│  │ ├─ Database (SQLite or PostgreSQL)         │   │
│  │ └─ Configuration                           │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ Node Resources (SSH/Podman)                 │   │
│  │ ├─ Static hosting                           │   │
│  │ ├─ Runtime containers                       │   │
│  │ └─ CDN/Reverse proxy                        │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Characteristics:**
- Single instance, administratively isolated
- Data stored locally (SQLite or self-managed PostgreSQL)
- SSH access to deploy nodes (already implemented!)
- Podman for containerized builds
- User-managed secrets and env vars
- No authentication complexity (internal network)

### SaaS Mode
```
┌────────────────────────────────────────────────────────┐
│ WatchTower Cloud (Multi-tenant)                        │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Auth Layer (GitHub OAuth + RBAC)                │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Dashboard API (FastAPI)                          │ │
│  │ ├─ Projects (multi-tenant isolation)            │ │
│  │ ├─ Builds & Deployments                         │ │
│  │ ├─ Team management                              │ │
│  │ └─ Billing (Stripe integration)                 │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Build Infrastructure (auto-scaling)              │ │
│  │ ├─ Kubernetes or Docker Swarm                   │ │
│  │ ├─ Multiple regions                             │ │
│  │ └─ Resource pooling                             │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Managed Hosting (for preview/prod apps)          │ │
│  │ ├─ Edge runtime (Cloudflare Workers/Deno)       │ │
│  │ ├─ Dynamic provisioning                          │ │
│  │ └─ Auto-scaling                                 │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ PostgreSQL + Redis (shared multi-tenant DB)      │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘

                       ↓
        ┌──────────────────────────────┐
        │ User Project Deployments      │
        │ (on managed infrastructure)   │
        └──────────────────────────────┘
```

**Characteristics:**
- Multi-tenant architecture (database-level isolation)
- GitHub OAuth for authentication
- Team/organization management
- Billing & subscription tiers
- SLA & uptime guarantees
- Auto-scaling resources
- Managed database & backups

---

## 3. USE CASE FEATURE MATRIX

| Feature | Netlify-like (A) | Vercel-like (B) | Docker Platform (C) |
|---------|------------------|-----------------|-------------------|
| **Git Webhook** | ✅ | ✅ | ✅ |
| **Build System** | npm/pnpm/yarn | npm/pnpm/yarn + Next.js optimization | Any (Dockerfile) |
| **Static Hosting** | ✅ Primary | ✅ Preview/prod | ❌ |
| **SSR Runtime** | ❌ | ✅ Node.js | ❌ |
| **API Routes** | ✅ (functions) | ✅ (routes) | ✅ (containers) |
| **Custom Domains** | ✅ | ✅ | ✅ |
| **HTTPS/TLS** | ✅ Let's Encrypt | ✅ Let's Encrypt | ✅ Let's Encrypt |
| **CDN** | ✅ | ✅ | Optional |
| **Preview Deployments (PR)** | ✅ | ✅ | ✅ |
| **Rollback** | ✅ | ✅ | ✅ |
| **Env Var Management** | ✅ | ✅ | ✅ |
| **Container Orchestration** | ❌ | ❌ | ✅ |
| **Multi-container Apps** | ❌ | ❌ | ✅ (docker-compose) |
| **Secrets Management** | ✅ | ✅ | ✅ |
| **Build Logs** | ✅ | ✅ | ✅ |
| **Runtime Logs** | ❌ | ✅ | ✅ |
| **Metrics/Observability** | Basic | Advanced | Container metrics |
| **Cold Start Optimization** | N/A | ✅ | N/A |

---

## 4. SETUP WIZARD FLOW (UI/UX)

### Step 1: Deployment Model Selection
```
┌─────────────────────────────────────┐
│ WatchTower Setup Wizard             │
├─────────────────────────────────────┤
│                                     │
│ How do you want to deploy?          │
│                                     │
│ ○ Self-Hosted (on my server)        │
│ ○ SaaS Cloud (use WatchTower Cloud) │
│                                     │
│      [Next] [Cancel]                │
└─────────────────────────────────────┘
```

### Step 2: Use Case Selection
```
┌─────────────────────────────────────────────────┐
│ WatchTower Setup Wizard                         │
├─────────────────────────────────────────────────┤
│                                                 │
│ What do you want to deploy?                    │
│                                                 │
│ ○ Static Sites + Functions (Netlify-like)      │
│    (Best for: React, Vue, Next.js SSG)         │
│                                                 │
│ ○ Full-Stack Apps with SSR (Vercel-like)       │
│    (Best for: Next.js, Nuxt, SvelteKit)       │
│                                                 │
│ ○ Docker Apps (Self-hosted Platform)           │
│    (Best for: Any Dockerfile app)              │
│                                                 │
│      [Next] [Back] [Cancel]                    │
└─────────────────────────────────────────────────┘
```

### Step 3: Auth Setup (SaaS Only)
```
┌──────────────────────────────────────┐
│ WatchTower Setup - Authentication     │
├──────────────────────────────────────┤
│                                      │
│ Sign in with GitHub                  │
│                                      │
│  [GitHub OAuth Button]               │
│                                      │
│ (Connects to your GitHub account     │
│  for repo access)                    │
│                                      │
│      [Next] [Back] [Cancel]          │
└──────────────────────────────────────┘
```

### Step 4: Repository Connection
```
┌──────────────────────────────────────┐
│ Connect Repository                   │
├──────────────────────────────────────┤
│                                      │
│ GitHub Repository                    │
│ [Dropdown: Select from your repos]   │
│                                      │
│ Branch to deploy (default: main)     │
│ [Input: main]                        │
│                                      │
│ Build command                        │
│ [Input: npm ci && npm run build]     │
│                                      │
│      [Next] [Back] [Cancel]          │
└──────────────────────────────────────┘
```

### Step 5: Deployment Target (Use-case Specific)

#### 5A: Netlify-like
```
┌──────────────────────────────────────┐
│ Netlify-like: Hosting Setup          │
├──────────────────────────────────────┤
│                                      │
│ Project Name: [Input]                │
│                                      │
│ Output directory (build artifacts):  │
│ [Input: dist]                        │
│                                      │
│ Custom Domain (optional):            │
│ [Input: mysite.com]                  │
│                                      │
│ Enable Functions (serverless):       │
│ [Toggle: ON/OFF]                     │
│                                      │
│ Functions directory:                 │
│ [Input: api/ (if enabled)]           │
│                                      │
│      [Deploy] [Back] [Cancel]        │
└──────────────────────────────────────┘
```

#### 5B: Vercel-like
```
┌──────────────────────────────────────┐
│ Vercel-like: SSR Setup               │
├──────────────────────────────────────┤
│                                      │
│ Project Name: [Input]                │
│                                      │
│ Framework detected: Next.js           │
│ (Auto-detected from package.json)    │
│                                      │
│ Custom Domain (optional):            │
│ [Input: myapp.com]                   │
│                                      │
│ Enable Preview Deployments:          │
│ [Toggle: ON/OFF]                     │
│                                      │
│ Environment Variables:               │
│ [Add variable button]                │
│                                      │
│      [Deploy] [Back] [Cancel]        │
└──────────────────────────────────────┘
```

#### 5C: Docker Platform
```
┌──────────────────────────────────────┐
│ Docker Platform: App Setup           │
├──────────────────────────────────────┤
│                                      │
│ App Name: [Input]                    │
│                                      │
│ Dockerfile path:                     │
│ [Input: ./Dockerfile (default)]      │
│                                      │
│ Port to expose:                      │
│ [Input: 3000]                        │
│                                      │
│ Docker Compose (optional):           │
│ [Toggle: with docker-compose]        │
│                                      │
│ Environment Variables:               │
│ [Add variable button]                │
│                                      │
│ Deploy target nodes (self-hosted):   │
│ [Multiselect: Select nodes]          │
│                                      │
│      [Deploy] [Back] [Cancel]        │
└──────────────────────────────────────┘
```

### Step 6: Review & Deploy
```
┌──────────────────────────────────────┐
│ Review Configuration                 │
├──────────────────────────────────────┤
│                                      │
│ Deployment Model: Self-Hosted        │
│ Use Case: Netlify-like               │
│ Repository: user/repo                │
│ Branch: main                         │
│ Build Command: npm run build         │
│ Create Custom Subdomain: myapp       │
│                                      │
│      [Confirm & Deploy]              │
│      [Back] [Cancel]                 │
└──────────────────────────────────────┘
```

---

## 5. DATABASE SCHEMA

### Core Tables (SQLAlchemy models)

```python
# User & Auth
users:
  - id (UUID)
  - email (str)
  - github_id (int, optional)
  - name (str)
  - created_at
  - updated_at

organizations:  # Self-hosted: default org, SaaS: multiple
  - id (UUID)
  - name (str)
  - owner_id (fk: users)
  - created_at

# Projects
projects:
  - id (UUID)
  - org_id (fk: organizations)
  - name (str)
  - use_case (enum: netlify_like, vercel_like, docker_platform)
  - deployment_model (enum: self_hosted, saas)
  - repo_url (str)
  - repo_branch (str, default: main)
  - webhook_secret (str)
  - created_at

# Deployments
deployments:
  - id (UUID)
  - project_id (fk: projects)
  - commit_sha (str)
  - branch (str)
  - status (enum: pending, building, deploying, live, failed)
  - trigger (enum: webhook, manual, scheduled)
  - created_at
  - deployed_at (nullable)

# Builds
builds:
  - id (UUID)
  - deployment_id (fk: deployments)
  - status (enum: pending, running, success, failed)
  - container_id (str, Podman container)
  - build_command (str)
  - build_output (text)
  - started_at
  - completed_at
  - duration_seconds (int)

# Configuration (Use-case specific)
netlify_like_configs:
  - project_id (fk: projects)
  - output_dir (str)
  - functions_dir (str, optional)
  - enable_functions (bool)

vercel_like_configs:
  - project_id (fk: projects)
  - framework (str)
  - enable_preview_deployments (bool)

docker_platform_configs:
  - project_id (fk: projects)
  - dockerfile_path (str)
  - exposed_port (int)
  - docker_compose_path (str, optional)
  - target_nodes (str, comma-separated node names)

# Environment & Secrets
environment_variables:
  - id (UUID)
  - project_id (fk: projects)
  - key (str)
  - value (str, encrypted)
  - environment (enum: development, staging, production)

# Domains & TLS
custom_domains:
  - id (UUID)
  - project_id (fk: projects)
  - domain (str)
  - is_primary (bool)
  - tls_enabled (bool)
  - tls_cert_path (str, nullable)
  - letsencrypt_validated (bool)
  - created_at

# Nodes (for self-hosted ssh/podman deployment)
nodes:
  - id (UUID)
  - name (str)
  - host (str)
  - user (str)
  - port (int)
  - remote_path (str)
  - ssh_key_path (str)
  - reload_command (str)
```

---

## 6. ARCHITECTURE: BACKEND APIS

### Core API Endpoints

#### Projects
- `GET /api/projects` - List user's projects
- `POST /api/projects` - Create new project
- `GET /api/projects/{id}` - Get project details
- `PUT /api/projects/{id}` - Update project
- `DELETE /api/projects/{id}` - Delete project

#### Deployments
- `GET /api/projects/{id}/deployments` - List deployments
- `POST /api/projects/{id}/deployments` - Trigger manual deployment
- `GET /api/deployments/{id}` - Get deployment details
- `POST /api/deployments/{id}/rollback` - Rollback to previous

#### Builds
- `GET /api/deployments/{id}/builds` - Get build info
- `WS /api/builds/{id}/logs` - Stream build logs in real-time

#### Webhooks
- `POST /webhook/github` - GitHub push/PR webhook handler
- `POST /webhook/gitlab` - GitLab webhook handler

#### Configuration (Use-case specific)
- `GET /api/projects/{id}/config` - Get current config
- `PUT /api/projects/{id}/config` - Update config

#### Domains & TLS
- `GET /api/projects/{id}/domains` - List domains
- `POST /api/projects/{id}/domains` - Add custom domain
- `POST /api/domains/{id}/validate` - Validate domain ownership

#### Environment Variables
- `GET /api/projects/{id}/env` - List env vars
- `POST /api/projects/{id}/env` - Add env var
- `DELETE /api/projects/{id}/env/{key}` - Delete env var

#### SaaS-specific
- `GET /api/organizations` - List orgs (multi-tenant)
- `POST /api/organizations` - Create org
- `GET /api/user` - Get current user

---

## 7. IMPLEMENTATION ROADMAP

### **Phase 1: MVP (Self-Hosted, Netlify-like)**
Timeline: 4-6 weeks

**Goal:** Deploy static sites from Git

- [x] Existing: Git pull, build, SSH deploy
- [ ] Dashboard UI (React)
- [ ] Database schema (projects, deployments, builds)
- [ ] Setup wizard (steps 1-6)
- [ ] Basic API endpoints (projects, deployments)
- [ ] Webhook listener (GitHub)
- [ ] Build logs streaming
- [ ] Custom domain + HTTPS (Let's Encrypt)

**Deliverable:** Single self-hosted instance can deploy static sites like Netlify

---

### **Phase 2: Expand Use Cases (Self-Hosted)**
Timeline: 4-6 weeks

**Goal:** Support Vercel-like (SSR) and Docker platform

- [ ] Vercel-like config (Next.js detection, SSR runtime)
- [ ] Docker platform config (Dockerfile support)
- [ ] Preview deployments for PRs
- [ ] Use-case-specific setup UI
- [ ] Framework detection (Next.js, Nuxt, SvelteKit, etc.)
- [ ] Serverless functions support (for Netlify-like)
- [ ] Environment-specific deployments (dev/staging/prod)

**Deliverable:** Self-hosted WatchTower can deploy all 3 types

---

### **Phase 3: Multi-tenant SaaS**
Timeline: 6-8 weeks

**Goal:** Cloud-hosted multi-tenant platform

- [ ] GitHub OAuth integration
- [ ] Multi-tenant database isolation
- [ ] Team/organization management
- [ ] RBAC (roles: owner, admin, developer, viewer)
- [ ] Billing integration (Stripe)
- [ ] SaaS-specific dashboard
- [ ] Managed build infrastructure (auto-scaling)
- [ ] Regional deployment options

**Deliverable:** Cloud.watchtower.dev with managed hosting

---

### **Phase 4: Advanced Features**
Timeline: 4-6 weeks

**Goal:** Parity with Netlify/Vercel

- [ ] Advanced observability (metrics, error tracking)
- [ ] Automated tests in CI/CD pipeline
- [ ] Advanced rollback strategies (canary, blue-green)
- [ ] Analytics (build times, deployment success rate)
- [ ] API tokens for programmatic access
- [ ] Slack/Discord integrations
- [ ] Custom webhook events
- [ ] Performance monitoring (Lighthouse integration)

---

## 8. TECH STACK

### Backend
- **Framework:** FastAPI (already in use)
- **Database:** PostgreSQL (SaaS), SQLite (self-hosted) via SQLAlchemy
- **Container:** Podman (build runner, already integrated)
- **Task Queue:** Celery + Redis (async builds & deploys)
- **Auth:** OAuth2 + JWT
- **TLS:** python-certifi + Let's Encrypt

### Frontend
- **Framework:** React 19+ with TypeScript
- **State:** TanStack Query (data fetching) + Zustand (client state)
- **Styling:** Tailwind CSS
- **Components:** Shadcn/ui
- **Forms:** React Hook Form + Zod
- **WebSocket:** Socket.io (real-time logs)

### Infrastructure
- **Containerization:** Docker/Podman
- **Orchestration:** (Self-hosted: systemd) (SaaS: Kubernetes)
- **Reverse Proxy:** Nginx + Let's Encrypt
- **Monitoring:** Prometheus + Grafana (optional)

---

## 9. QUICK START: Phase 1

### What you need to build first:

1. **React Dashboard** (single-page app)
   - Projects list
   - Setup wizard (all 6 steps)
   - Deployment history
   - Build logs viewer

2. **API Layer** (FastAPI)
   - Projects CRUD
   - Deployments CRUD
   - Webhook handler (GitHub)
   - Build log streaming (WebSocket)

3. **Database** (SQLAlchemy models)
   - Projects, Deployments, Builds, Domains, EnvVars

4. **UI/UX**
   - Wizard component
   - Dashboard layout
   - Real-time log viewer

---

## 10. FILES TO CREATE

```
watchtower/
├── api/
│   ├── __init__.py
│   ├── main.py                 # FastAPI app
│   ├── routes/
│   │   ├── projects.py
│   │   ├── deployments.py
│   │   ├── builds.py
│   │   ├── webhooks.py
│   │   ├── domains.py
│   │   └── env_vars.py
│   ├── models/
│   │   ├── project.py
│   │   ├── deployment.py
│   │   ├── build.py
│   │   ├── domain.py
│   │   └── env_var.py
│   ├── schemas/
│   │   ├── project.py
│   │   ├── deployment.py
│   │   └── ...
│   └── deps.py                 # Dependencies
├── web/
│   ├── src/
│   │   ├── app.tsx
│   │   ├── components/
│   │   │   ├── SetupWizard.tsx
│   │   │   ├── Dashboard.tsx
│   │   │   ├── LogViewer.tsx
│   │   │   └── ...
│   │   ├── pages/
│   │   ├── hooks/
│   │   └── utils/
│   ├── package.json
│   └── vite.config.ts
└── docker-compose.yml          # Local dev stack
```

---

## NEXT STEPS

1. **Confirm this roadmap** (anything you want to change?)
2. **Start Phase 1: MVP**
   - Set up React dashboard scaffold
   - Create database schema
   - Build setup wizard UI
   - Implement core API endpoints
3. **Test with a simple static site**
4. **Iterate based on feedback**

---

**Questions?**
- Which phase should we start with?
- Do you want me to scaffold the React dashboard first?
- Should we use PostgreSQL or SQLite for the MVP?
