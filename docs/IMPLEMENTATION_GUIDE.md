# WatchTower 2.0 - Implementation Guide

## 🔗 How They Work Together

WatchTower is designed to work with a complete integration stack. Here's how each component plays its part:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Podman runs containers → Nginx proxies traffic → Tailscale secures SSH    │
│  ↓                                                                           │
│  Cloudflare exposes to internet → Coolify provides PaaS UI → WatchTower    │
│  ↓                                                                           │
│  Watchdog keeps it all alive after reboots                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Each Component's Role

| Tool | Purpose | WatchTower Integration |
|---|---|---|
| **Podman** | Container runtime | WatchTower monitors, updates, and auto-restarts containers |
| **Nginx** | Reverse proxy & load balancer | Routes traffic to containerized apps, SSL termination |
| **Tailscale** | Mesh VPN network | Secures SSH access between nodes, encrypted comms |
| **Cloudflare** | DDoS protection & CDN | Exposes apps to the internet with Tunnel/Workers |
| **Coolify** | PaaS management layer | Provides clean UI for app deployment & lifecycle |
| **WatchTower Watchdog** | Autonomous restart service | **Auto-restarts all containers after reboot or crash** |

### Why This Stack?

- **Self-hosted** — you own and control everything
- **Decoupled** — each tool does one job well
- **Resilient** — watchdog ensures continuity after hardware events
- **Observable** — all 6 tools show live status in WatchTower's Integrations page
- **Minimal overhead** — lightweight control plane, no vendor lock-in

### Managing the Stack

Use the **Integrations** page (`/integrations`) to:
- ✅ See live connection status for all 6 tools
- 🔄 Toggle the Podman Watchdog (auto-restart on reboot)
- 📋 View install commands for each tool
- 🔗 Understand how they connect and depend on each other

---

## Overview

You now have a fully scaffolded WatchTower 2.0 platform with:

### ✅ Backend (Python/FastAPI)
- **Database Layer** (`watchtower/database.py`)
  - SQLAlchemy ORM models
  - Support for SQLite (dev) and PostgreSQL (prod)
  - Complete schema for projects, deployments, builds, configs

- **API Layer** (`watchtower/api/`)
  - Projects CRUD endpoints
  - Deployments management
  - Builds & logs
  - GitHub webhook listener
  - Setup wizard completion

- **Schemas** (`watchtower/schemas.py`)
  - Pydantic models for validation
  - 3 use-case configs (Netlify-like, Vercel-like, Docker)
  - Request/response types

### ✅ Frontend (React/TypeScript)
- **Setup Wizard** (`web/src/pages/SetupWizard.tsx`)
  - 4-step guided setup
  - Dynamic forms based on use case
  - All 3 deployment models supported

- **Dashboard** (`web/src/pages/Dashboard.tsx`)
  - Project listing
  - Quick start UI

- **UI Components** (`web/src/components/ui/`)
  - Card, Button, Input, Label, Select, Checkbox
  - Tailwind CSS styling
  - Fully typed

### ✅ Infrastructure
- **Docker Compose** (`docker-compose.yml`)
  - PostgreSQL database
  - Redis for task queues
  - FastAPI server with hot reload

---

## Phase 1: Quick Start (MVP)

### Step 1: Install Dependencies

```bash
# Backend
pip install -r requirements-new.txt

# Frontend
cd web
npm install
```

### Step 2: Start Local Development Stack

```bash
# Terminal 1: Start Docker Compose (PostgreSQL + Redis)
docker-compose up -d

# Terminal 2: Run FastAPI backend
uvicorn watchtower.api:app --reload --port 8000

# Terminal 3: Run React frontend
cd web && npm run dev
```

**Services will be available at:**
- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`
- API Docs: `http://localhost:8000/docs` (Swagger UI)
- Database: `localhost:5432` (PostgreSQL)

### Step 3: Test the Setup Wizard

1. Open `http://localhost:5173/setup`
2. Follow the 4-step wizard:
   - Select deployment model (self-hosted)
   - Select use case (netlify_like)
   - Enter repository (e.g., `https://github.com/user/repo`)
   - Configure project (output_dir: `dist`, etc.)
3. Click "Create Project"

### Step 4: Verify in API

```bash
# Check projects created
curl http://localhost:8000/api/projects \
  -H "Authorization: Bearer test-token"

# Check API docs
open http://localhost:8000/docs
```

---

## Project Structure Recap

```
watchtower/
├── api/
│   ├── projects.py         # Project CRUD routes
│   ├── deployments.py      # Deployment management
│   ├── builds.py           # Build/logs routes
│   ├── webhooks.py         # GitHub webhook handler
│   ├── setup.py            # Setup wizard endpoint
│   └── util.py             # Auth & utilities
├── database.py             # SQLAlchemy models + session
├── schemas.py              # Pydantic validation schemas
└── api.py                  # FastAPI app setup

web/
├── src/
│   ├── components/ui/      # Base UI components
│   ├── pages/              # Page components
│   ├── lib/
│   ├── store/              # Zustand state
│   ├── App.tsx             # Router & layout
│   └── main.tsx            # Entry point
├── package.json
├── tailwind.config.js
└── vite.config.ts

docker-compose.yml          # Dev environment
```

---

## Phase 1: MVP Roadmap

### ✅ Done
- [ ] Database schema ✅
- [ ] API endpoints (basic CRUD) ✅
- [ ] Setup wizard UI ✅
- [ ] GitHub webhook listener skeleton ✅
- [ ] React dashboard skeleton ✅
- [ ] Docker development environment ✅

### 🚧 Still To Do

#### 1. Authentication (Week 1)
- [ ] GitHub OAuth integration (for SaaS)
- [ ] JWT token generation & validation
- [ ] Local user management (self-hosted)
- [ ] RBAC (roles: owner, admin, developer, viewer)
- [ ] Session management

**Files to create:**
- `watchtower/auth.py` - OAuth, JWT, RBAC logic
- `web/src/pages/Login.tsx` - Login page
- `web/src/hooks/useAuth.ts` - Auth hook

#### 2. Build Runner (Week 2)
- [ ] Integrate Podman for containerized builds
- [ ] Build job queuing (Celery + Redis)
- [ ] Build log streaming (WebSocket)
- [ ] Support all 3 use cases (npm/pnpm, Next.js, Dockerfile)
- [ ] Error handling & retries

**Files to create:**
- `watchtower/builder.py` - Build orchestration
- `watchtower/tasks.py` - Celery tasks
- `web/src/components/LogViewer.tsx` - Real-time logs

#### 3. Deployment & Hosting (Week 2-3)
- [ ] SSH node management (already have nodes.json)
- [ ] Rsync artifact distribution
- [ ] Nginx reverse proxy configuration
- [ ] Let's Encrypt TLS automation
- [ ] Custom domain routing

**Files to create:**
- `watchtower/deployer.py` - Deploy orchestration
- `watchtower/tls.py` - Let's Encrypt integration
- `watchtower/nginx.py` - Nginx config generation

#### 4. Dashboard Features (Week 3)
- [ ] Projects list with live status
- [ ] Deployment history view
- [ ] Build logs viewer
- [ ] Domain management UI
- [ ] Environment variables UI

**Files to update:**
- `web/src/pages/Dashboard.tsx` - Expand with real data
- `web/src/components/` - Add DeploymentList, LogViewer, etc.

#### 5. Testing (Week 4)
- [ ] Backend API tests (pytest)
- [ ] Frontend component tests (Vitest)
- [ ] E2E tests (Playwright)
- [ ] GitHub Actions CI/CD

**Files to create:**
- `tests/test_api.py` - API tests
- `web/tests/` - Frontend tests

---

## Detailed Tasks for Next Sprint

### Task 1: Implement GitHub OAuth (Authentication)

**Backend files to create:**
```python
# watchtower/auth.py
class GitHubOAuth:
    def get_github_url() -> str:
        """Generate GitHub OAuth authorize URL"""
    
    def exchange_code_for_token(code: str) -> dict:
        """Exchange auth code for access token"""
    
    def get_user_info(token: str) -> dict:
        """Fetch user info from GitHub"""

# watchtower/api/auth.py
@router.get("/auth/github")
async def github_login():
    """Redirect to GitHub OAuth"""

@router.get("/auth/github/callback")
async def github_callback(code: str, db: Session = Depends(get_db)):
    """Handle GitHub callback"""
```

**Frontend files to create:**
```typescript
// web/src/pages/Login.tsx
// Displays GitHub login button, handles callback

// web/src/hooks/useAuth.ts
// useEffect to check token in localStorage
// useQuery to fetch current user
```

### Task 2: Implement Build Runner (Podman Integration)

**Backend files to create:**
```python
# watchtower/builder.py
class BuildRunner:
    async def clone_repo(repo_url: str, branch: str) -> str:
        """Git clone repo to local dir"""
    
    async def run_build(
        project: Project, 
        deployment: Deployment
    ) -> Build:
        """Execute build in Podman container"""
    
    async def upload_artifacts(
        build: Build,
        artifact_path: Path
    ) -> str:
        """Upload to S3/R2/storage"""

# watchtower/tasks.py (Celery)
@celery_app.task
def build_project(deployment_id: str):
    """Async build task"""
```

### Task 3: Webhook GitHub -> Deployment

**Already done in** `watchtower/api/webhooks.py`

Just need to:
- [ ] Link webhook to build queue
- [ ] Update deployment status -> BUILDING
- [ ] Emit real-time updates

---

## Database Migrations

Since you're using SQLAlchemy, set up Alembic for migrations:

```bash
# Initialize migrations
alembic init alembic

# Create first migration
alembic revision --autogenerate -m "initial schema"

# Apply migrations
alembic upgrade head
```

---

## Environment Variables

Create `.env` file:

```env
# Backend
DATABASE_URL=postgresql://watchtower:watchtower-dev@localhost:5432/watchtower
REDIS_URL=redis://localhost:6379
LOG_LEVEL=INFO
CORS_ORIGINS=http://localhost:5173

# GitHub OAuth (SaaS only)
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_REDIRECT_URI=http://localhost:8000/api/auth/github/callback

# Additional
SECRET_KEY=your-secret-key-here
ENVIRONMENT=development
```

---

## Testing & Verification

### Test Setup Wizard API

```bash
# Create project via API
curl -X POST http://localhost:8000/api/setup/wizard/complete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{
    "deployment_model": "self_hosted",
    "use_case": "netlify_like",
    "repo_url": "https://github.com/user/repo",
    "repo_branch": "main",
    "build_command": "npm run build",
    "project_name": "My Site",
    "output_dir": "dist"
  }'
```

### Verify Database

```python
# Python shell
from watchtower.database import SessionLocal, Project
db = SessionLocal()
projects = db.query(Project).all()
print(f"Found {len(projects)} projects")
```

---

## Deployment Checklist (Self-Hosted)

For deploying WatchTower itself:

- [ ] Use PostgreSQL (not SQLite)
- [ ] Set up Redis
- [ ] Configure HTTPS (Let's Encrypt)
- [ ] Setup backup strategy
- [ ] Configure monitoring
- [ ] Setup automated updates

**Deployment script:**
```bash
# deploy.sh (already in repo, enhance it)
docker-compose -f docker-compose.prod.yml up -d
# Handle migrations
# Start Celery workers
```

---

## Next Steps

1. **Try it locally first** - Follow Quick Start above
2. **Test the wizard** - Create a project end-to-end
3. **Implement auth** - Add GitHub OAuth
4. **Add build runner** - Queue & execute builds
5. **Add deployment** - Use your existing SSH nodes
6. **Dashboard features** - Show live deployments

---

## Support Files

### Swagger/OpenAPI Docs
- Automatically available at `http://localhost:8000/docs`
- Execute requests directly from browser

### Database Schema Viewer
```bash
# Generate ER diagram
pip install sqlalchemy-utils
python -c "from watchtower.database import Base; print(Base.metadata.tables.keys())"
```

### Rate Limiting (Future)
```python
# Install
pip install slowapi

# Add to FastAPI
from slowapi import Limiter
from slowapi.util import get_remote_address
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
```

---

## Common Issues & Solutions

### Issue: "Module not found" errors
**Solution:** Make sure you're in the right directory and venv is activated
```bash
source .venv/bin/activate  # Unix/Mac
.venv\Scripts\activate     # Windows
```

### Issue: Database connection errors
**Solution:** Check docker-compose is running
```bash
docker-compose ps
docker-compose logs postgres
```

### Issue: CORS errors in frontend
**Solution:** Check CORS_ORIGINS environment variable
```bash
# Should include http://localhost:5173
export CORS_ORIGINS="http://localhost:5173,http://localhost:8000"
```

### Issue: React components not rendering
**Solution:** Make sure all dependencies are installed
```bash
cd web
npm install
npm run dev
```

---

## Questions?

Refer to:
- `WATCHTOWER_PLATFORM_ROADMAP.md` - Full vision & architecture
- `watchtower/database.py` - Database schema
- `web/src/pages/SetupWizard.tsx` - Wizard implementation
- API docs at `http://localhost:8000/docs`

Good luck! 🚀
