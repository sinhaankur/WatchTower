# WatchTower Frontend

React + TypeScript dashboard for WatchTower deployment platform.

## Project Structure

```
src/
├── components/          # Reusable UI components
│   └── ui/             # Base UI components (Card, Button, etc.)
├── pages/              # Page components
│   ├── Dashboard.tsx   # Main dashboard
│   └── SetupWizard.tsx # Setup wizard
├── hooks/              # Custom React hooks
├── lib/                # Utility functions
├── store/              # State management (Zustand)
├── App.tsx             # Root app component
└── main.tsx            # Entry point
```

## Installation

```bash
cd web
npm install
```

## Development

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

It proxies API requests to `http://localhost:8000`

## Building

```bash
npm run build
```

## Tech Stack

- **React 19** - UI library
- **TypeScript** - Type safety
- **Vite** - Build tool
- **TailwindCSS** - Styling
- **React Query** - Data fetching
- **Zustand** - State management
- **React Hook Form** - Form handling
- **Zod** - Validation
- **Lucide React** - Icons
