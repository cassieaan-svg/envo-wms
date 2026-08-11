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

### Backend
- **Node.js** - Runtime
- **Express.js** - Web framework
- **CORS** - Cross-origin request handling

## Getting Started

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0

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
