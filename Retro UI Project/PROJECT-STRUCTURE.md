# 📁 v0 Calendar - Project Structure

## Overview
This project follows Next.js 13+ App Router conventions with a clean, scalable architecture.

## 📂 Directory Structure

\`\`\`
v0-calendar/
├── app/                          # Next.js App Router
│   ├── [username]/[slug]/        # Public booking pages
│   ├── api/                      # API routes
│   ├── auth/callback/            # OAuth callback
│   ├── booking/[id]/confirmed/   # Booking confirmation
│   ├── events/                   # Event management
│   ├── layout.tsx               # Root layout
│   └── page.tsx                 # Dashboard
│
├── components/                   # Reusable UI components
│   ├── ui/                      # shadcn/ui components
│   ├── calendar.tsx             # Main calendar component
│   ├── booking-form.tsx         # Booking form
│   └── ...                      # Feature components
│
├── lib/                         # Business logic & utilities
│   ├── actions/                 # Server Actions
│   │   ├── bookings.ts         # Booking operations
│   │   └── event-types.ts      # Event type operations
│   ├── auth/                    # Authentication utilities
│   ├── supabase/               # Database client setup
│   ├── utils/                  # Helper functions
│   ├── availability.ts         # Availability logic
│   ├── email.ts               # Email handling
│   └── google-calendar.ts     # Google Calendar integration
│
├── types/                       # TypeScript definitions
│   └── index.ts                # Shared types
│
├── scripts/                     # Database setup
│   └── 000-complete-setup.sql  # Single setup script
│
└── README-DATABASE-SETUP.md     # Setup documentation
\`\`\`

## 🏗️ Architecture Principles

### ✅ **Separation of Concerns**
- **UI Components**: Pure presentation logic
- **Server Actions**: Business logic & database operations  
- **API Routes**: External integrations & webhooks
- **Types**: Shared TypeScript definitions

### ✅ **Security First**
- Row Level Security (RLS) policies
- Server-side validation
- Authenticated vs public routes clearly separated

### ✅ **Developer Experience**
- Consistent naming conventions
- Clear file organization
- TypeScript throughout
- Comprehensive error handling

## 🚀 **Scalability Features**

- **Modular components** - Easy to extend
- **Server Actions** - Type-safe database operations
- **Dynamic routing** - Supports multi-tenant architecture
- **Clean abstractions** - Business logic separated from UI

## 🔒 **Security Measures**

- **RLS Policies** - Database-level security
- **Input validation** - Server-side validation
- **OAuth integration** - Secure Google Calendar access
- **Environment variables** - Sensitive data protection

This structure supports rapid development while maintaining code quality and security standards.
