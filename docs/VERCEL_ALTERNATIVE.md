# WatchTower: Self-Hosted Vercel Alternative

**WatchTower is built to mimic Vercel's deployment model while giving you complete control and dramatically lower costs.**

---

## Why WatchTower Instead of Vercel?

| Feature | Vercel | WatchTower |
|---------|--------|-----------|
| **Cost** | $20–$150+/month per app | $0 (self-hosted) |
| **Control** | Managed (vendor lock-in) | Complete (your infrastructure) |
| **Multi-node deployments** | Enterprise plan required | Built-in from day one |
| **Custom integrations** | Limited | Full access to your stack |
| **Private deployments** | Behind VPN only | Tailscale mesh included |
| **Beta/preview environments** | Available | Built-in preview slots |
| **Cold start times** | Fixed by Vercel | You control serverless alternatives |
| **Data residency** | Must trust Vercel | Your choice of region |

---

## Feature Parity with Vercel

### ✅ Deployment & Releases
- **Vercel:** Git push triggers automated builds
- **WatchTower:** Same — push to `main`, WatchTower builds and deploys automatically

### ✅ Preview Environments
- **Vercel:** Auto-preview for pull requests
- **WatchTower:** Dedicated preview slots with separate URLs (mesh topology)

### ✅ Rollback & Health Checks
- **Vercel:** One-click rollback, automatic health detection
- **WatchTower:** Same — plus visible deployment history and per-node status

### ✅ Environment Variables & Secrets
- **Vercel:** Environment configurations per project
- **WatchTower:** Same — encrypted in your database, full control

### ✅ Domain & SSL
- **Vercel:** Vercel domains or custom DNS
- **WatchTower:** Full SSL via Cloudflare, your custom domains, complete DNS control

### ✅ Analytics & Logs
- **Vercel:** Built-in analytics dashboard
- **WatchTower:** Live logs, container metrics, and deployment timelines (extensible)

### ✅ Team Collaboration
- **Vercel:** Team billing and project sharing
- **WatchTower:** Multi-user dashboard with role-based access (roadmap: RBAC)

---

## When to Use WatchTower Over Vercel

### **Cost-sensitive teams**
- Running 3+ applications? WatchTower saves $500–$2000/year compared to Vercel.
- Self-hosting costs only electricity + your infrastructure.

### **Need for data control**
- Healthcare, finance, or regulated industries requiring data residency
- WatchTower keeps everything on your nodes — no third-party access

### **Multi-region or hybrid deployments**
- Deploy to your own servers, Coolify, or managed services simultaneously
- Vercel charges per-region; WatchTower handles multi-node for free

### **Beta & staging workflows**
- Full preview environment support without additional costs
- Test new features across multiple branches and nodes

### **Integration with existing infrastructure**
- Already using Podman, Nginx, Tailscale? WatchTower integrates seamlessly
- Avoid learning another vendor's ecosystem

### **Production-ready workloads**
- High-availability setup with database backup and recovery
- 99.9% uptime through watchdog auto-restart and mesh topology

---

## Vercel → WatchTower Migration Path

### From Vercel's CLI to WatchTower
```bash
# Vercel workflow
vercel deploy
vercel env pull
vercel logs

# WatchTower workflow
watchtower app push
watchtower env set --env production
watchtower logs --tail -f
```

### Vercel Domains → Cloudflare + Tailscale
| Vercel | WatchTower |
|--------|-----------|
| `myapp.vercel.app` | `myapp.your-domain.com` (Cloudflare) + `internal.tailnet.ts.net` (Tailscale) |
| Domain management | Full control via Cloudflare + ACME for SSL |
| Preview links | Automatically generated for each slot |

### Teams & Billing
| Vercel | WatchTower |
|--------|-----------|
| Team management via Vercel dashboard | Native multi-user dashboard |
| Pay Vercel per team member | Unlimited users on your instance |
| Central billing | You manage your hosting costs |

---

## Real-World Example: Blog + API

### Vercel ($60–80/month)
- Frontend on Vercel: $20/month
- API on Vercel: $20/month
- Database: $20/month (managed)
- Domain: included

### WatchTower (one-time infrastructure only)
- Linux server (Digital Ocean, Hetzner, AWS): $5–20/month
- Cloudflare DNS + DDoS: free tier
- Everything else runs on your node
- **Savings: $40–60/month or $500–700/year**

### Deployment flow
```
Git push to main
  ↓
GitHub webhook → WatchTower API
  ↓
Build (via container or your build system)
  ↓
Test & health check
  ↓
Deploy to live slot (or preview if branch)
  ↓
Cloudflare routes traffic
  ↓
Tailscale secures SSH for ops
```

---

## Beta Testing & Going Live with WatchTower

### Beta Testing (Staging)
1. Deploy to a preview slot via a feature branch
2. Share the auto-generated preview URL
3. Test with real data and real infrastructure
4. Merge to `main` to go live

**No separate staging environment costs — everything is the same platform.**

### Going Live (Production)
1. Configure HA with primary + standby nodes (optional)
2. Set up database backups (PostgreSQL snapshots)
3. Enable watchdog for auto-restart
4. Monitor health and logs from the dashboard

**First deploy is free. Ongoing cost is your infrastructure only.**

### Scaling Beyond One Node
- Add new nodes via SSH in the Servers page
- Deploy the same app to multiple nodes
- Nginx load-balancing across nodes
- Tailscale keeps inter-node communication encrypted

---

## Feature Roadmap: Closing the Gap

| Feature | Status | Vercel Equivalent |
|---------|--------|------------------|
| Git push → automatic deploy | ✅ Done | Vercel Git Integration |
| Multi-environment support | ✅ Done | Vercel environments |
| Preview slots | ✅ Done | Vercel preview deployments |
| Rollback to previous versions | ✅ Done | Vercel deployments list |
| Health checks & auto-restart | ✅ Done | Vercel auto-recovery |
| Live logs & deployment history | ✅ Done | Vercel logs |
| Integrations hub (Docker, Nginx, Tailscale, Cloudflare) | ✅ Done | Vercel integrations |
| Team multi-user dashboard | 🚧 In Progress | Vercel team dashboard |
| RBAC (role-based access control) | 🚧 Roadmap | Vercel team roles |
| Automatic scaling | 🚧 Roadmap | Vercel auto-scaling |
| Edge functions (on your nodes) | 🚧 Roadmap | Vercel Edge Functions |

---

## Getting Started

### Option 1: Single Node (Fastest)
```bash
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower
./run.sh                        # Starts on 127.0.0.1:8000
```
**Perfect for:** Local dev, testing, small single-server deployments

### Option 2: Docker (Production-like)
```bash
export WATCHTOWER_API_TOKEN="your-secure-token"
docker compose -f docker-compose.app.yml up -d
```
**Perfect for:** Staging, beta testing, small production workloads

### Option 3: HA (High Availability)
```bash
docker compose -f deploy/docker-compose.ha.yml up -d
```
**Perfect for:** Production apps that must not go down

### Option 4: Multi-Node Mesh
```bash
docker compose -f deploy/docker-compose.mesh.yml up -d
```
**Perfect for:** Global deployments, multi-region apps, extreme resilience

---

## Example: Deploy a Next.js App to WatchTower

### Step 1: Create Your App
```bash
npx create-next-app@latest myapp
cd myapp
git init && git add . && git commit -m "initial"
git remote add origin https://github.com/your-org/myapp.git
git push -u origin main
```

### Step 2: Register in WatchTower
1. Open WatchTower dashboard (`http://127.0.0.1:8000`)
2. Go to **Projects**
3. Click **Add Project**
4. Select repository: `https://github.com/your-org/myapp.git`
5. Select build profile: `Next.js` (auto-detected)
6. Confirm output directory: `.next`

### Step 3: Deploy
```bash
cd myapp
git push origin main              # Triggers webhook
# WatchTower auto-builds, tests, and deploys
```

### Step 4: View Live
- **Live:** `https://myapp.your-domain.com` (Cloudflare)
- **Dashboard:** See build log, deployment status, container health

### Step 5: Deploy Preview
```bash
git checkout -b feature/new-feature
# ... make changes ...
git push origin feature/new-feature
```
WatchTower automatically creates a preview slot and posts the URL on your PR.

---

## Support & Community

- **Issues & Bug Reports:** [GitHub Issues](https://github.com/sinhaankur/WatchTower/issues)
- **Documentation:** [Full Docs](https://sinhaankur.github.io/WatchTower/)
- **Discussions:** [GitHub Discussions](https://github.com/sinhaankur/WatchTower/discussions)
- **Roadmap:** [PLATFORM_BUILD_SUMMARY.md](./PLATFORM_BUILD_SUMMARY.md)

---

## License

MIT — Free to use, modify, and redistribute. See [LICENSE](../LICENSE).

**WatchTower: Own your infrastructure. Control your deployments. Cut your costs.**
