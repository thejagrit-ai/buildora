# Real Estate CRM — Full System Design Prompt
### For: AI Builder / Senior Development Team
### Stack: React (frontend) · Node.js (backend) · REST/GraphQL API

---

## ROLE & OBJECTIVE

You are a senior full-stack architect and product designer. Your task is to design and build a **production-grade Real Estate CRM** for a mid-to-large real estate developer. The system must handle Residential, Commercial, and Mixed-use properties across the complete customer lifecycle — from marketing campaign to booking, payment, and post-sale reporting.

The system must be architected to Salesforce CRM quality standards: role-based access, audit trails, workflow automation, and a responsive UI. It is **not** built on Salesforce — it is a custom React + Node.js application.

---

## TECH STACK

| Layer | Technology |
|---|---|
| Frontend | React 18+, TypeScript, Tailwind CSS, React Query |
| State Management | Zustand or Redux Toolkit |
| Backend | Node.js 20+, Express or Fastify, TypeScript |
| Database | PostgreSQL (primary), Redis (cache/sessions) |
| ORM | Prisma |
| Auth | JWT + Refresh Tokens, RBAC middleware |
| File Storage | AWS S3 or compatible (documents, floor plans, images) |
| Email/SMS | SendGrid + Twilio |
| Charts & Reports | Recharts or Apache ECharts |
| Search | PostgreSQL full-text or Elasticsearch |
| Deployment | Docker + Docker Compose; CI/CD via GitHub Actions |

---

## USER ROLES & PERMISSIONS

Define a strict RBAC (Role-Based Access Control) system with the following roles:

| Role | Key Permissions |
|---|---|
| **Super Admin** | Full system access; user management; global config |
| **CRM Admin** | Module config, data import/export, workflow rules |
| **Sales Agent** | Own leads/opportunities; site visits; quotations; bookings |
| **Channel Partner / Broker** | Assigned leads only; limited inventory view; own bookings |
| **Project Manager** | Inventory management; site visit scheduling; read-only bookings |
| **Finance Team** | Demand letters, receipts, booking financials; no lead editing |

All roles must enforce:
- Row-level security (users see only their assigned/owned records by default)
- Field-level visibility (e.g., finance figures hidden from agents unless assigned)
- Audit log on every create/update/delete

---

## DATA ARCHITECTURE — CORE ENTITIES

Design a normalized PostgreSQL schema. Key entities and their relationships:

```
Campaign → Lead → Account → Opportunity → Site Visit
                                        → Quotation → Booking → Demand & Receipt
                                                              ↑
                                                         Inventory Unit
```

Core tables (minimum):
- `campaigns`, `campaign_sources`, `campaign_responses`
- `leads`, `lead_activity_log`
- `accounts`, `contacts`
- `opportunities`, `opportunity_stages`
- `site_visits`, `visit_feedback`
- `inventory_projects`, `inventory_towers`, `inventory_units`
- `quotations`, `quotation_line_items`
- `bookings`, `booking_documents`
- `demand_schedules`, `receipts`, `payment_transactions`
- `reports_saved`, `dashboard_widgets`
- `users`, `roles`, `permissions`, `audit_logs`

---

## MODULE SPECIFICATIONS

---

### MODULE 1 — CAMPAIGN MANAGEMENT

**Purpose:** Plan, execute, and measure marketing campaigns that generate leads.

**Key Features:**
- Create campaigns with: Name, Type (Digital, Print, Events, Referral, Channel Partner), Start/End Date, Budget, Target Segment (Residential/Commercial/Mixed), Project association
- Campaign source tracking (Google Ads, Facebook, Instagram, Email, Walk-in, Referral, Broker)
- UTM parameter capture for digital campaigns
- Campaign performance dashboard: Leads generated, Cost per Lead, Conversion rate to Opportunity, ROI
- Campaign cloning for recurring campaigns
- Budget vs. Actual spend tracking
- Status workflow: Draft → Active → Paused → Completed → Archived

**API Endpoints:**
```
GET    /api/campaigns
POST   /api/campaigns
GET    /api/campaigns/:id
PUT    /api/campaigns/:id
PATCH  /api/campaigns/:id/status
GET    /api/campaigns/:id/leads
GET    /api/campaigns/:id/analytics
```

**Business Rules:**
- A lead must always trace back to a campaign source
- Campaigns cannot be deleted if they have associated leads; they can only be archived
- Budget alerts trigger when spend exceeds 80% and 100% of budget

---

### MODULE 2 — LEAD MANAGEMENT

**Purpose:** Capture, qualify, assign, and nurture inbound and outbound leads.

**Key Features:**
- Lead capture: Manual entry, Web form embed (via API token), Bulk CSV import, WhatsApp/IVR integration hooks
- Lead fields: Name, Mobile, Email, Source, Campaign, Property Interest (Type, BHK, Budget Range, Preferred Location), Lead Score (0–100), Lead Stage
- Lead Stage pipeline (Kanban + List view):
  - New → Contacted → Qualified → Site Visit Scheduled → Negotiation → Converted / Lost
- Auto-assignment rules: Round-robin, geography-based, or manual
- Lead deduplication: match by mobile number or email; merge duplicates
- Lead activity timeline: calls, emails, WhatsApp, notes, stage changes
- Lead scoring engine: configurable weightage on source, engagement, budget, property type
- SLA breach alerts: notify manager if lead not contacted within X hours
- Lead nurture sequences: automated email/SMS drip on stage change
- Lost reason capture (mandatory on marking lost)

**API Endpoints:**
```
GET    /api/leads
POST   /api/leads
GET    /api/leads/:id
PUT    /api/leads/:id
PATCH  /api/leads/:id/stage
POST   /api/leads/:id/activities
GET    /api/leads/:id/timeline
POST   /api/leads/import
POST   /api/leads/:id/convert
POST   /api/leads/deduplicate
```

**Business Rules:**
- Converting a lead auto-creates an Account + Contact + Opportunity
- Only one active opportunity per lead–unit combination allowed
- Channel partners can only see leads assigned to them; cannot reassign

---

### MODULE 3 — ACCOUNT MANAGEMENT

**Purpose:** Manage customer/company accounts and their contacts across the buying lifecycle.

**Key Features:**
- Account types: Individual Buyer, Corporate Buyer, Channel Partner / Broker, Investor
- Account fields: Name, Type, PAN/GSTIN, Address, Communication preferences, KYC status, Documents (Aadhaar, PAN, Passport)
- Multiple contacts per account (primary + secondary)
- 360° account view: All leads, opportunities, site visits, bookings, payments linked
- Account activity feed
- KYC workflow: Pending → Submitted → Verified → Rejected
- Duplicate detection on PAN / mobile / email
- Document vault per account (upload, version, download)
- Channel Partner accounts: commission structure, empanelment date, agreement upload, performance stats

**API Endpoints:**
```
GET    /api/accounts
POST   /api/accounts
GET    /api/accounts/:id
PUT    /api/accounts/:id
POST   /api/accounts/:id/contacts
GET    /api/accounts/:id/documents
POST   /api/accounts/:id/documents
GET    /api/accounts/:id/timeline
```

**Business Rules:**
- Account must have at least one contact marked primary
- KYC must be verified before a booking can be confirmed
- Channel partner accounts require empanelment approval by CRM Admin

---

### MODULE 4 — OPPORTUNITY MANAGEMENT

**Purpose:** Track every active sales deal from qualification to closure.

**Key Features:**
- Opportunity fields: Name, Account, Project, Unit of Interest, Stage, Expected Close Date, Deal Value, Probability %, Assigned Agent, Source Campaign
- Opportunity stages with probability defaults:
  - Prospect (10%) → Qualified (25%) → Site Visit Done (40%) → Negotiation (60%) → Verbal Commit (80%) → Won (100%) / Lost (0%)
- Stage-gate checklist: each stage can have required tasks before progression
- Pipeline view: Kanban by stage with deal value totals
- Forecasting: weighted pipeline value by month/quarter
- Competitive tracking: note competitor projects being evaluated
- Co-ownership: two agents on one opportunity (split commission)
- Activity log: all interactions against the opportunity
- Stale deal alerts: no activity in X days

**API Endpoints:**
```
GET    /api/opportunities
POST   /api/opportunities
GET    /api/opportunities/:id
PUT    /api/opportunities/:id
PATCH  /api/opportunities/:id/stage
GET    /api/opportunities/pipeline
GET    /api/opportunities/forecast
POST   /api/opportunities/:id/activities
```

**Business Rules:**
- Closing as Won requires a linked Booking
- Closing as Lost requires a lost reason and competitor name (optional)
- Only one open opportunity can be linked to a single inventory unit at a time (soft block with override for manager)

---

### MODULE 5 — SITE VISIT MANAGEMENT

**Purpose:** Schedule, track, and capture feedback for property site visits.

**Key Features:**
- Schedule a visit: Lead/Opportunity, Date & Time, Project/Unit to visit, Assigned escort agent, Transport arrangement (cab/self), Reminder (SMS/email 24h and 1h before)
- Visit status: Scheduled → Confirmed → Completed → No-show → Cancelled
- Post-visit feedback form (filled by agent): Rating (1–5), Interested units, Budget confirmation, Next action, Remarks
- Visit calendar view (per agent, per project)
- Multiple visits per opportunity (visit history)
- Walk-in visit capture (unscheduled)
- Manager view: visits by project, by agent, by date range
- Visit-to-conversion analytics

**API Endpoints:**
```
GET    /api/site-visits
POST   /api/site-visits
GET    /api/site-visits/:id
PATCH  /api/site-visits/:id/status
POST   /api/site-visits/:id/feedback
GET    /api/site-visits/calendar
GET    /api/site-visits/analytics
```

**Business Rules:**
- A visit cannot be scheduled for a past date
- Feedback is mandatory before marking a visit Completed
- No-show visits auto-trigger a follow-up task on the linked lead

---

### MODULE 6 — INVENTORY MANAGEMENT

**Purpose:** Manage the real estate project inventory — projects, towers, floors, and individual units.

**Key Features:**

**Project Setup:**
- Project: Name, Type (Residential/Commercial/Mixed), Location, RERA number, Launch date, Possession date, Total units, Amenities, Documents (brochure, floor plan, RERA cert)
- Tower/Block: Name, floors, units per floor
- Unit: Unit number, Floor, Type (1BHK/2BHK/Studio/Office/Retail/Plot), Super built-up area, Carpet area, Facing, Base price per sqft, PLC charges, Floor rise charges, Car parking charges

**Unit Status (color-coded grid view):**
- Available (green)
- Blocked / On Hold (yellow) — with expiry timer
- Booked (orange)
- Registered (blue)
- Cancelled (red)

**Features:**
- Interactive floor plan view with unit status overlay
- Inventory grid (floor × unit matrix per tower)
- Pricing configurator: base price + add-ons (PLC, floor rise, parking, club house)
- Hold/Block unit with time-limited lock (configurable: 24h, 48h, 72h) and hold reason
- Hold expiry auto-releases unit to Available
- Bulk price revision with effective date and revision history
- Unit comparison tool (side by side, up to 3 units)
- Inventory summary: total, available, blocked, booked, sold counts

**API Endpoints:**
```
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id/inventory
GET    /api/projects/:id/towers/:towerId/units
POST   /api/inventory/units
GET    /api/inventory/units/:id
PATCH  /api/inventory/units/:id/status
POST   /api/inventory/units/:id/hold
DELETE /api/inventory/units/:id/hold
GET    /api/inventory/units/:id/price-history
PUT    /api/inventory/pricing/bulk
```

**Business Rules:**
- Only one active booking or block allowed per unit at a time
- Hold expiry must trigger a notification to the holding agent
- Price revisions do not affect already-booked or confirmed units
- Cancellation of a Booked unit requires Finance approval workflow

---

### MODULE 7 — BOOKING MANAGEMENT

**Purpose:** Formalize a customer's intent to purchase with a booking record and agreement.

**Key Features:**
- Booking form: Account (must be KYC verified), Unit, Booking Date, Booking Amount, Payment Mode, Co-applicants, Agent, Channel Partner (if referred)
- Auto-generate: Booking ID, Allotment Letter (PDF), Booking Form (PDF)
- Booking status: Initiated → Booking Amount Received → Agreement Sent → Agreement Signed → Confirmed → Cancelled
- Booking documents vault: upload signed agreement, cheque images, NOC
- Co-applicant management: add multiple owners, RERA compliance fields
- Cancellation workflow: reason, cancellation charges, refund initiation
- Booking amendment: unit change (subject to availability), applicant name change (with approval)
- Channel partner commission calculation on booking confirmation
- Integration with Demand & Receipt for payment schedule generation

**Auto-generated Documents (PDF):**
- Allotment Letter
- Booking Form / Application Form
- Payment Schedule (demand note)

**API Endpoints:**
```
GET    /api/bookings
POST   /api/bookings
GET    /api/bookings/:id
PATCH  /api/bookings/:id/status
POST   /api/bookings/:id/documents
POST   /api/bookings/:id/cancel
POST   /api/bookings/:id/amend
GET    /api/bookings/:id/commission
```

**Business Rules:**
- A booking cannot be created without a verified Account and an Available/Held unit
- Booking Amount must be recorded before status moves to "Booking Amount Received"
- Cancellation requires CRM Admin + Finance Team dual approval
- A confirmed booking automatically locks the linked Opportunity as Won

---

### MODULE 8 — DEMAND & RECEIPT MANAGEMENT

**Purpose:** Manage the post-booking payment lifecycle — demand schedules, payment receipts, and outstanding tracking.

**Key Features:**

**Demand Schedule:**
- Auto-generate payment schedule on booking confirmation based on pre-configured payment plan templates
- Plan types: Construction-linked, Time-linked, Custom
- Milestone-based demand (e.g., On booking, On foundation, On slab, On possession)
- Manual demand generation (ad hoc)
- Demand letter PDF generation (with due date, amount, GST breakup)
- Bulk demand generation for a milestone across multiple bookings
- Demand status: Pending → Sent → Partially Paid → Paid → Overdue

**Receipt Management:**
- Record payment receipt: Booking ID, Amount, Mode (NEFT/RTGS/Cheque/UPI/DD), Bank reference, Date, Remarks
- Auto-reconcile receipt against demand
- Partial payment handling (remaining demand stays open)
- Receipt PDF generation with company letterhead
- Cheque dishonour tracking and reissuance
- GST breakup on each receipt (configurable rates)
- Outstanding ledger per booking: total demanded, total paid, balance

**API Endpoints:**
```
GET    /api/bookings/:id/demands
POST   /api/bookings/:id/demands
GET    /api/demands/:id
PATCH  /api/demands/:id/status
POST   /api/demands/bulk-generate
GET    /api/bookings/:id/receipts
POST   /api/bookings/:id/receipts
GET    /api/receipts/:id
GET    /api/bookings/:id/ledger
GET    /api/demands/overdue
```

**Business Rules:**
- A receipt cannot exceed the total demanded amount for a booking (with override for advance)
- GST calculations must be itemized (current rates: 5% for under-construction residential, configurable)
- Overdue demands (past due date) auto-trigger escalation notifications to Finance team and agent
- Receipt numbers must be sequential and tamper-proof

---

### MODULE 9 — QUOTATION MANAGEMENT

**Purpose:** Generate formal price quotes for a customer before booking, including all cost components.

**Key Features:**
- Create quotation: Account, Unit, Validity date, Price breakdown
- Quote line items:
  - Basic Sale Price (BSP = area × rate)
  - Preferential Location Charges (PLC: floor, facing, corner)
  - Floor Rise Charges
  - Car Parking (open / covered / stack)
  - Club House / AHC charges
  - Infrastructure / Development charges
  - GST (auto-calculated)
  - Registration / Stamp Duty estimate (informational)
  - Total Cost of Ownership
- Discount module: flat amount, percentage, or scheme-based (approval required for >X%)
- Multiple quote versions per opportunity (v1, v2, v3...)
- Quote status: Draft → Sent → Viewed → Accepted → Revised → Expired → Declined
- Quote-to-PDF generation (branded, print-ready)
- Quote sharing via email / link (trackable — capture when customer opens)
- Quote acceptance triggers Booking creation
- Approval workflow: discounts beyond threshold → Manager → Finance approval

**API Endpoints:**
```
GET    /api/quotations
POST   /api/quotations
GET    /api/quotations/:id
PUT    /api/quotations/:id
PATCH  /api/quotations/:id/status
POST   /api/quotations/:id/send
GET    /api/quotations/:id/pdf
POST   /api/quotations/:id/accept
GET    /api/opportunities/:id/quotations
POST   /api/quotations/:id/revise
```

**Business Rules:**
- Quotation validity expiry auto-changes status to Expired
- Accepted quotation locks all pricing — no edits after acceptance
- Discount approvals follow a configurable threshold matrix (e.g., Agent: 0–1%, Manager: 1–3%, Finance: 3–5%)
- Each quote version must be retained for audit; previous versions cannot be deleted

---

### MODULE 10 — REPORTS & DASHBOARD

**Purpose:** Provide real-time operational visibility and management-level analytics across all modules.

**Dashboard Design:**
- Role-based default dashboards (each role sees relevant KPIs on login)
- Drag-and-drop widget layout (save per user)
- Date range filter (Today, This Week, This Month, This Quarter, Custom)
- Project filter (All / specific project)

**Standard KPI Widgets:**
- Total leads this period / conversion rate
- Pipeline value by stage (funnel chart)
- Site visits scheduled vs. completed
- Inventory availability donut (Available / Blocked / Booked / Registered)
- Collections this month vs. target
- Overdue demands count and value
- Top performing agents (leads converted, bookings done)
- Revenue booked vs. target (gauge)

**Standard Reports (pre-built, exportable to Excel/PDF):**

| Report Name | Key Dimensions |
|---|---|
| Lead Summary Report | Source, Stage, Agent, Campaign, Date range |
| Lead Aging Report | Time in each stage, SLA breach |
| Site Visit Report | Agent, Project, Status, Conversion |
| Opportunity Pipeline Report | Stage, Value, Agent, Expected close |
| Inventory Status Report | Project, Tower, Floor, Unit, Status |
| Booking Register | Unit, Customer, Date, Booking amount, Agent |
| Collection Report | Booking, Demand, Receipt, Date, Mode |
| Demand Outstanding Report | Booking, Overdue amount, Days overdue |
| Agent Performance Report | Leads, Visits, Bookings, Collections per agent |
| Channel Partner Report | CP name, Leads, Bookings, Commission earned |
| Campaign ROI Report | Campaign, Leads, CPL, Bookings, Revenue |
| Cancellation Report | Booking, Reason, Refund status |

**Custom Report Builder:**
- Drag-and-drop field selector from any module
- Filter conditions (AND/OR logic)
- Group by and aggregate functions (SUM, COUNT, AVG)
- Save and schedule reports (email delivery: daily/weekly/monthly)

**API Endpoints:**
```
GET    /api/reports/leads
GET    /api/reports/inventory
GET    /api/reports/collections
GET    /api/reports/pipeline
GET    /api/reports/agent-performance
GET    /api/reports/cp-performance
GET    /api/reports/campaign-roi
POST   /api/reports/custom
GET    /api/dashboard/widgets
PUT    /api/dashboard/widgets/layout
GET    /api/dashboard/kpis
```

---

## CROSS-CUTTING CONCERNS

### Notifications & Alerts
- In-app notification bell (real-time via WebSocket or Server-Sent Events)
- Email notifications: lead assignment, visit reminder, demand due, booking confirmed, KYC rejected
- SMS notifications: visit reminder, booking confirmation, payment receipt
- Notification preferences per user
- Notification log (read/unread, timestamp, linked record)

### Audit Trail
- Every record mutation logged: who, what, when, old value, new value
- Audit log viewer in admin panel (searchable by user, module, date)
- Audit logs are immutable (append-only)

### Search
- Global search bar: search across leads, accounts, opportunities, units, bookings by name, mobile, email, unit number
- Fuzzy matching for names
- Elasticsearch or PostgreSQL full-text search index

### Document Management
- S3-backed file storage
- Documents categorized per record type
- Version history for agreements
- Secure signed URL generation for downloads (expiry: 15 min)
- Supported formats: PDF, JPG, PNG, DOCX, XLSX

### Performance Requirements
- Dashboard KPIs: < 2s load time
- List views: paginated (50 records default), filterable, sortable
- Reports: async generation for large datasets (>10k rows); deliver via email or in-app notification
- Search: < 500ms response

### Security Requirements
- HTTPS only
- Input validation and sanitization on all endpoints (Zod or Joi)
- Rate limiting on auth and public endpoints
- CORS restricted to known domains
- SQL injection prevention via ORM (Prisma parameterized queries)
- Secrets management via environment variables (never hardcoded)
- Session management: JWT access (15 min) + Refresh token (7 days)

---

## UI/UX DESIGN REQUIREMENTS

### Design System
- Component library: Shadcn/ui or Ant Design Pro (choose one, document it)
- Responsive: Desktop-first, functional on tablet, minimal mobile support for agents
- Color system: Primary brand color (configurable per tenant), semantic colors for status (success/warning/error/info)
- Typography: Inter or Geist for UI; consistent scale

### Key UI Patterns
- All list views: filters sidebar + sortable columns + inline quick actions
- All detail views: left summary panel + right tabbed content (Timeline | Related | Documents | Activity)
- All forms: multi-step for complex flows (e.g., Booking), single-page for simple ones
- Pipeline/Kanban views: drag-and-drop stage progression for Leads and Opportunities
- Status badges: color-coded, consistent vocabulary across modules
- Empty states: actionable (e.g., "No leads yet — Import leads or add one manually")
- Confirmation dialogs: for all destructive actions with typed confirmation for irreversible actions

### Navigation
```
Sidebar (collapsible):
├── Dashboard
├── Campaigns
├── Leads
├── Accounts
│   ├── Customers
│   └── Channel Partners
├── Opportunities
├── Site Visits
├── Inventory
│   ├── Projects
│   └── Units
├── Bookings
├── Demand & Receipts
├── Quotations
├── Reports
└── Settings
    ├── Users & Roles
    ├── Workflow Rules
    ├── Notification Templates
    ├── Payment Plans
    └── System Config
```

---

## SETTINGS & CONFIGURATION MODULE

- User management: Create, deactivate, reset password, assign roles
- Workflow rules: Configurable stage transitions, assignment rules, SLA timers
- Notification templates: Email/SMS templates (Handlebars-style variables)
- Payment plan templates: Create named plans (Construction-linked, Time-linked)
- Price configuration: GST rates, stamp duty estimates per state
- Hold duration: Default hold expiry in hours
- Discount thresholds: Per role, per project
- Branding: Company logo, letterhead for PDF generation
- Data import/export: CSV import for leads, inventory units; full data export

---

## DELIVERABLES EXPECTED FROM THE BUILD

1. Fully functional React frontend (all 10 modules, TypeScript)
2. RESTful Node.js backend API (TypeScript, Prisma, PostgreSQL)
3. Prisma schema with all models and relations
4. RBAC middleware applied to all routes
5. PDF generation service (Puppeteer or pdf-lib) for: Allotment Letter, Booking Form, Quotation, Demand Letter, Receipt
6. Email service integration (SendGrid templates)
7. Docker Compose setup (app + db + redis)
8. Seed script for demo data (projects, users, sample leads, inventory)
9. API documentation (Swagger/OpenAPI 3.0)
10. Environment variable template (`.env.example`)

---

## CONSTRAINTS & NOTES FOR THE BUILDER

- Do not use any Salesforce-specific technology. This is a fully custom application.
- All monetary values stored as integers in paise (INR subunit) to avoid floating-point errors; display in rupees with ₹ symbol.
- All dates stored in UTC; display in IST (Asia/Kolkata) with user-configurable timezone support.
- RERA compliance fields must be present on Project and Booking records (RERA number, carpet area disclosure).
- The system must support multi-project (multiple real estate projects under one developer) from day one.
- Design for scale: a single developer may have 5,000+ active leads, 50,000+ inventory units across projects.
- Channel partner (broker) portal should be usable as a semi-isolated view — partners should only see their pipeline, not the developer's full data.

---

*Prompt version 1.0 — Real Estate CRM — Mixed (Residential + Commercial) — React + Node.js*
