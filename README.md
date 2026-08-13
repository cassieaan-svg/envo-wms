# ENVO Inventory Tracker

A role-aware inventory management system for healthcare commodities across multiple facilities.

## What it does

- Tracks stock at store, dispensary, DSD, and SDP locations
- Supports pharmacy and laboratory commodity sections
- Records dispensing, intake, stock adjustments, and transfers
- Provides activity logs, bin cards, AMC settings, alerts, monitoring, and reports
- Supplies multi-facility oversight for state, cluster, LGA, and overall administrators
- Publishes live stock updates through server-sent events

## Architecture

This is an npm-workspaces monorepo:

```
.
├── frontend/  # React + Vite application
└── backend/   # Express + PostgreSQL API
```

### Frontend

- React 19
- Vite
- Tailwind CSS
- Zustand

The UI routes users to the pages appropriate for their access level and commodity section. It uses compact stock-summary endpoints where possible, rather than downloading large raw stock datasets.

### Backend

- Node.js and Express
- PostgreSQL via `pg`
- JWT authentication
- Server-side facility, role, and commodity-section scoping
- Brotli/gzip response compression
- Server-sent events for real-time updates

The API includes stock, transfers, dispensing, intake, adjustments, reporting, facilities, commodities, AMC settings, edit history, and bin-card routes.

## Access model

The server enforces access control; the interface only reflects those permissions.

| Access level | Scope | Write access |
| --- | --- | --- |
| Facility user | Own facility and assigned section | Facility operations, subject to role |
| State admin | Assigned state, both sections | State-scoped stock and transfer management |
| Overall admin | All facilities and sections | Read-only oversight |
| State viewer | Assigned state | Read-only oversight |
| Cluster/LGA admin | Assigned cluster or LGA and section | Read-only oversight |

## Requirements

- Node.js 18 or later
- npm 9 or later
- PostgreSQL

Configure the backend database connection with standard `PG*` environment variables in `backend/.env`.

## Development

Install dependencies from the repository root:

```bash
npm install
```

Start the frontend:

```bash
npm run dev
```

Start the backend:

```bash
npm run dev:backend
```

Build the frontend:

```bash
npm run build
```

Run backend tests:

```bash
npm run test --workspace=backend
```

## Diagnostics

Set `ENVO_DIAG=1` to enable request timing diagnostics. The backend then exposes an admin-only pool diagnostic endpoint at `/api/_diag/pool`, and reports timing information through the `Server-Timing` response header. Diagnostics are disabled by default.

## Contributing

Create a feature branch, make and test your changes, then open a pull request for review.

## License

MIT License.
