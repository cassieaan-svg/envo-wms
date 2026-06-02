# ENVO Inventory Tracking System

A comprehensive inventory management system for healthcare facilities with separate frontend and backend components.

## Project Structure

```
inventory-tracker/
├── frontend/              # React + Vite frontend application
│   ├── src/
│   ├── package.json
│   └── vite.config.js
├── backend/               # Node.js/Express API server
│   ├── src/
│   ├── routes/
│   ├── middleware/
│   ├── package.json
│   └── .env.example
├── package.json           # Root workspace configuration
└── README.md
```

## Tech Stack

### Frontend
- **React 19** - UI framework
- **Vite** - Build tool
- **Tailwind CSS** - Styling
- **Zustand** - State management
- **Supabase JS Client** - Database client (will be replaced with API calls)

### Backend
- **Node.js** - Runtime
- **Express.js** - Web framework
- **Supabase** - Database and authentication
- **CORS** - Cross-origin request handling

## Getting Started

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-org/inventory-tracker.git
   cd inventory-tracker
   ```

2. **Install dependencies for both frontend and backend:**
   ```bash
   npm install
   ```
   This uses npm workspaces to install dependencies for both `frontend/` and `backend/`

### Environment Setup

1. **Frontend** - Create `.env` in `frontend/`:
   ```
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_anon_key
   ```

2. **Backend** - Copy `.env.example` to `.env`:
   ```bash
   cd backend
   cp .env.example .env
   ```
   Then update with your Supabase credentials:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_KEY=your_service_role_key
   ```

### Development

#### Run Frontend Only
```bash
npm run dev
```
Frontend runs on `http://localhost:5173`

#### Run Backend Only
```bash
npm run dev:backend
```
Backend runs on `http://localhost:5000`

#### Run Both Frontend and Backend
```bash
npm run dev:both
```

### Building

#### Build Frontend
```bash
npm run build
```

#### Build Backend
```bash
npm run build:backend
```

#### Build All
```bash
npm run build:all
```

## API Endpoints

The backend provides the following API structure (to be implemented):

### Stock Management
- `GET /api/stock` - Get stock for a facility
- `POST /api/stock` - Create stock record
- `PATCH /api/stock/:id` - Update stock

### Transfers
- `GET /api/transfers` - Get transfer requests
- `POST /api/transfers` - Create transfer request
- `PATCH /api/transfers/:id/approve` - Approve transfer
- `PATCH /api/transfers/:id/cancel` - Cancel transfer

### Dispense
- `GET /api/dispense` - Get dispense logs
- `POST /api/dispense` - Record dispense

### Reports
- `GET /api/reports/daily` - Daily report
- `GET /api/reports/weekly` - Weekly report
- `GET /api/reports/monthly` - Monthly report

## Features

- ✅ Multi-facility support
- ✅ Role-based access control (Store Manager, DSD User, Lab User, Admin)
- ✅ Real-time stock tracking
- ✅ Transfer request management
- ✅ Dispense logging
- ✅ Activity reports (daily, weekly, monthly)
- ✅ Light and dark mode UI
- ⏳ API backend (in progress)

## Project Phases

### Phase 1: Restructuring ✅ DONE
- Separated frontend and backend into workspaces
- Created backend template with Express.js
- Set up project structure and build scripts

### Phase 2: API Implementation (In Progress)
- Implement Supabase integration in backend
- Create API endpoints for all features
- Migrate frontend to use API instead of direct Supabase

### Phase 3: Enhancement
- Add real-time notifications
- Implement advanced reporting
- Optimize performance

## Contributing

1. Create a feature branch: `git checkout -b feature/feature-name`
2. Commit changes: `git commit -am 'Add feature'`
3. Push to branch: `git push origin feature/feature-name`
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions, please create an issue in the repository.
