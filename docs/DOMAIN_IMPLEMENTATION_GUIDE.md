# Domain Management - Implementation Guide

## 📋 PHASE 1: Domain UI & API

### Frontend: New Component Structure

```
web/src/pages/
├── Projects.tsx (existing)
├── ProjectDetail.tsx (NEW)
│   ├── Tabs: Overview | Domains | Settings | Deployments
│   └── Uses:
│       └── components/DomainManager/ (NEW)
│           ├── DomainList.tsx
│           ├── AddDomainModal.tsx
│           ├── DomainCard.tsx
│           └── DNSHelper.tsx
```

### Feature Breakdown

#### 1. **DomainList Component**
Shows all domains for a project with status

```tsx
// Shows:
// - Domain name
// - Status badge (Active ✓ | Validating ⏳ | Failed ✗)
// - TLS status & cert expiry countdown
// - Primary domain indicator
// - Actions (Test | Edit | Delete)

interface DomainListProps {
  projectId: string;
  domains: CustomDomainResponse[];
  onAdd: () => void;
  onDelete: (domainId: string) => void;
}
```

#### 2. **AddDomainModal Component**
Step-by-step domain setup wizard

```tsx
// Step 1: Enter domain
//   - Input: yourdomain.com
//   - Check if valid TLD
//   - Show current registrar detection (optional)

// Step 2: Choose TLS
//   - [x] Auto (Let's Encrypt) - RECOMMENDED
//   - [ ] Manual (provide cert)
//   - [ ] Skip TLS (HTTP only)

// Step 3: Set Primary
//   - [x] Make this the primary domain
//   - This is where app.example.com will load from

// Step 4: DNS Instructions
//   - "Point your domain nameservers to:"
//   - Copy/paste button for each nameserver
//   - Or add these DNS records:
//     TXT watchtower-verify.app.example.com=<token>
//   - "Once propagated, click Verify"

interface AddDomainModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}
```

#### 3. **DNSHelper Component**
Guides users through DNS setup for their registrar

```tsx
// Shows:
// - Selected registrar (auto-detected if possible)
// - Step-by-step instructions for that registrar
// - Common registrars:
//   - GoDaddy
//   - Namecheap
//   - Cloudflare
//   - Route53
//   - Others
// - Copy buttons for each record
// - "Check DNS" tool (polls status)

interface DNSHelperProps {
  domain: string;
  records: DNSRecord[];  // TXT records needed
  onVerified: () => void;
}
```

---

## 🔌 Backend: API Implementation

### New Endpoints (Complete)

```python
# POST /projects/{project_id}/domains
# Purpose: Register new domain
# Request:
{
  "domain": "example.com",
  "tls_enabled": true,
  "is_primary": true
}
# Response:
{
  "id": "uuid",
  "domain": "example.com",
  "status": "validating",
  "dns_records": [
    {
      "type": "TXT",
      "name": "_acme-challenge.example.com",
      "value": "xyz123..."
    }
  ],
  "created_at": "2026-04-25T..."
}

---

# GET /projects/{project_id}/domains
# Purpose: List all domains
# Response:
[
  {
    "id": "uuid",
    "domain": "example.com",
    "status": "active",  // or "validating" | "failed"
    "tls_enabled": true,
    "tls_cert_expiry": "2027-04-25",
    "is_primary": true,
    "dns_validated_at": "2026-04-25T...",
    "created_at": "2026-04-25T..."
  }
]

---

# GET /projects/{project_id}/domains/{domain_id}
# Purpose: Get domain details
# Response: (full CustomDomainResponse)

---

# POST /projects/{project_id}/domains/{domain_id}/verify
# Purpose: Manually trigger DNS validation check
# Response:
{
  "status": "active",  // or "validating" | "failed"
  "verified_at": "2026-04-25T...",
  "message": "DNS verified! TLS cert issued."
}

---

# DELETE /projects/{project_id}/domains/{domain_id}
# Purpose: Remove domain from project
# Response: { "success": true }

---

# PUT /projects/{project_id}/domains/{domain_id}/make-primary
# Purpose: Set as primary domain
# Response: (updated CustomDomainResponse)
```

### Database Enhancements

```python
# watchtower/database.py - Update CustomDomain model

class CustomDomain(Base):
    __tablename__ = "custom_domains"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"))
    domain = Column(String, unique=True, index=True)
    is_primary = Column(Boolean, default=False)
    
    # Status tracking
    status = Column(String, default="validating")  # validating | active | failed
    
    # TLS/Let's Encrypt
    tls_enabled = Column(Boolean, default=True)
    tls_cert_path = Column(String, nullable=True)
    letsencrypt_validated = Column(Boolean, default=False)
    tls_expiry = Column(DateTime, nullable=True)
    
    # DNS validation
    dns_token = Column(String, nullable=True)  # For TXT record validation
    dns_records = Column(JSON, nullable=True)  # Stores TXT records needed
    dns_validated_at = Column(DateTime, nullable=True)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    project = relationship("Project", back_populates="custom_domains")
```

### Service Implementation

```python
# watchtower/services/domain_service.py (NEW)

class DomainService:
    """Handle domain registration, validation, and TLS"""
    
    async def register_domain(
        self,
        db: Session,
        project_id: UUID,
        domain: str,
        tls_enabled: bool = True,
        is_primary: bool = False
    ) -> CustomDomain:
        """
        1. Validate domain format
        2. Generate validation token
        3. Create DNS TXT record requirement
        4. Save to database
        5. Start validation check loop
        """
        
        # Generate validation token
        token = secrets.token_urlsafe(32)
        
        # Create domain record
        domain_record = CustomDomain(
            project_id=project_id,
            domain=domain,
            dns_token=token,
            tls_enabled=tls_enabled,
            is_primary=is_primary,
            status="validating",
            dns_records=[
                {
                    "type": "TXT",
                    "name": f"_acme-challenge.{domain}",
                    "value": token
                }
            ]
        )
        
        db.add(domain_record)
        db.commit()
        db.refresh(domain_record)
        
        # Start background validation task
        asyncio.create_task(self.validate_dns_loop(domain_record.id))
        
        return domain_record
    
    async def validate_dns_loop(self, domain_id: UUID, max_attempts: int = 30):
        """
        Check DNS records every 10 seconds
        Stop after 5 minutes or when validated
        """
        import dns.resolver
        
        domain = db.query(CustomDomain).filter(CustomDomain.id == domain_id).first()
        if not domain:
            return
        
        for attempt in range(max_attempts):
            try:
                # Query DNS for TXT record
                answers = dns.resolver.resolve(
                    f"_acme-challenge.{domain.domain}",
                    "TXT"
                )
                
                # Check if our token is in the DNS records
                for rdata in answers:
                    if domain.dns_token in str(rdata):
                        # DNS validated!
                        domain.status = "active"
                        domain.dns_validated_at = datetime.utcnow()
                        
                        # If TLS enabled, trigger Let's Encrypt
                        if domain.tls_enabled:
                            await self.request_letsencrypt_cert(domain)
                        
                        db.commit()
                        logger.info(f"Domain {domain.domain} DNS validated")
                        return
                
            except dns.exception.DNSException as e:
                logger.debug(f"DNS not yet propagated: {e}")
            
            # Wait 10 seconds before next check
            await asyncio.sleep(10)
        
        # Max attempts reached
        domain.status = "failed"
        db.commit()
        logger.warning(f"Domain {domain.domain} validation failed after {max_attempts * 10}s")
    
    async def request_letsencrypt_cert(self, domain: CustomDomain):
        """
        Use certbot or similar to request LE cert
        Save cert path to domain.tls_cert_path
        """
        # Implementation using certbot or acme library
        # For now, placeholder
        logger.info(f"Requesting Let's Encrypt cert for {domain.domain}")
```

---

## 🗺️ Reverse Proxy Integration (Caddy)

### Caddy Configuration Updates

```
# config/caddy/Caddyfile

# Load custom domains from file
import /etc/caddy/custom_domains/*

# Example custom domain entry (generated per domain):
# watchtower-prod.example.com {
#     tls /certs/example.com.crt /certs/example.com.key
#     reverse_proxy localhost:8080
#     encode gzip
# }
```

### Domain Sync Service

```python
# watchtower/services/caddy_sync_service.py (NEW)

class CaddySyncService:
    """
    Syncs domain configuration to Caddy
    Called whenever a domain is registered/updated/deleted
    """
    
    async def sync_domain_to_caddy(self, domain: CustomDomain):
        """
        Generate Caddyfile block for this domain
        Write to /etc/caddy/custom_domains/{domain_id}.conf
        Reload Caddy
        """
        
        caddy_config = f"""
{domain.domain} {{
    # TLS
    tls {domain.tls_cert_path if domain.tls_enabled else "off"}
    
    # Reverse proxy to project runtime
    reverse_proxy localhost:{project_port}
    
    # Compression
    encode gzip
    
    # CORS headers (optional)
    header -Server
}}
"""
        
        # Write to Caddy config directory
        config_path = f"/etc/caddy/custom_domains/{domain.id}.conf"
        with open(config_path, "w") as f:
            f.write(caddy_config)
        
        # Reload Caddy
        os.system("caddy reload -c /etc/caddy/Caddyfile")
```

---

## 📊 Migration Path

### Step 1: Database Migration
```python
# migrations/add_domain_fields.py

"""Add domain status and DNS tracking fields"""

def upgrade():
    op.add_column('custom_domains', sa.Column('status', sa.String, default='validating'))
    op.add_column('custom_domains', sa.Column('dns_token', sa.String, nullable=True))
    op.add_column('custom_domains', sa.Column('dns_records', sa.JSON, nullable=True))
    op.add_column('custom_domains', sa.Column('dns_validated_at', sa.DateTime, nullable=True))
    op.add_column('custom_domains', sa.Column('tls_expiry', sa.DateTime, nullable=True))

def downgrade():
    op.drop_column('custom_domains', 'status')
    # ... etc
```

### Step 2: API Implementation
```python
# watchtower/api/domains.py (NEW ROUTER)

router = APIRouter(prefix="/api/projects", tags=["domains"])

@router.post("/{project_id}/domains", response_model=CustomDomainResponse)
async def add_domain(project_id: UUID, ...):
    # Implemented using DomainService

@router.get("/{project_id}/domains", response_model=List[CustomDomainResponse])
async def list_domains(project_id: UUID, ...):
    # Query and return

# ... other endpoints
```

### Step 3: Frontend Implementation
```tsx
// 1. Create DomainManager component
// 2. Add to ProjectDetail page
// 3. Connect to new API endpoints
// 4. Add DNS helper UI
```

---

## ✅ Testing Checklist

- [ ] Add domain with valid format
- [ ] Reject invalid domains (example.invalidu)
- [ ] Generate correct DNS TXT records
- [ ] Poll DNS until validated (timeout after 5 min)
- [ ] Request Let's Encrypt cert after DNS validation
- [ ] Sync domain config to Caddy
- [ ] Route traffic through domain correctly
- [ ] Auto-renew TLS 30 days before expiry
- [ ] Delete domain and clean up configs
- [ ] Show correct status in UI (validating → active → cert expiry countdown)

---

## 🎯 Success Criteria

**User flow:**
1. Go to project → "Domains" tab
2. Click "+ Add Domain"
3. Enter domain name
4. See DNS instructions for their registrar
5. Copy/paste DNS records in GoDaddy/Cloudflare/etc
6. Click "Verify"
7. ⏳ Wait 1-5 minutes
8. ✅ Domain active, TLS configured
9. 🚀 https://example.com → project

**Time to working domain: ~5 minutes (with DNS propagation delay)**

