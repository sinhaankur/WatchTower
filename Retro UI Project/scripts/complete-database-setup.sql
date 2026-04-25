-- ============================================================================
-- v0 Calendar - Complete Database Setup Script (Consolidated)
-- ============================================================================
-- This script sets up the entire database schema for the v0 Calendar project.
-- Run this script once on a fresh Supabase project to get everything working.
-- This script is idempotent - it can be run multiple times safely.
-- ============================================================================

-- ============================================================================
-- 1. CREATE TABLES
-- ============================================================================

-- Create users table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE,
  full_name TEXT,
  avatar_url TEXT,
  email TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  google_calendar_id TEXT,
  google_access_token TEXT,
  google_refresh_token TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create event_types table with all columns including new ones
CREATE TABLE IF NOT EXISTS public.event_types (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  duration INTEGER NOT NULL, -- in minutes
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  availability JSONB DEFAULT '{"monday": {"enabled": true, "slots": [{"start": "09:00", "end": "17:00"}]}, "tuesday": {"enabled": true, "slots": [{"start": "09:00", "end": "17:00"}]}, "wednesday": {"enabled": true, "slots": [{"start": "09:00", "end": "17:00"}]}, "thursday": {"enabled": true, "slots": [{"start": "09:00", "end": "17:00"}]}, "friday": {"enabled": true, "slots": [{"start": "09:00", "end": "17:00"}]}, "saturday": {"enabled": false, "slots": []}, "sunday": {"enabled": false, "slots": []}}',
  timezone TEXT,
  booking_limit INTEGER DEFAULT NULL,
  booking_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

-- Add timezone column if it doesn't exist (for existing installations)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_types' AND column_name = 'timezone') THEN
    ALTER TABLE public.event_types ADD COLUMN timezone TEXT;
  END IF;
END $$;

-- Add booking limit columns if they don't exist (for existing installations)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_types' AND column_name = 'booking_limit') THEN
    ALTER TABLE public.event_types ADD COLUMN booking_limit INTEGER DEFAULT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'event_types' AND column_name = 'booking_count') THEN
    ALTER TABLE public.event_types ADD COLUMN booking_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- Create bookings table with all columns including guest_timezone and guest_ip
CREATE TABLE IF NOT EXISTS public.bookings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type_id UUID REFERENCES public.event_types(id) ON DELETE CASCADE NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  notes TEXT,
  guest_timezone TEXT,
  guest_ip TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add guest_timezone column if it doesn't exist (for existing installations)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'guest_timezone') THEN
    ALTER TABLE public.bookings ADD COLUMN guest_timezone TEXT;
  END IF;
END $$;

-- Add guest_ip column if it doesn't exist (for existing installations)
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'guest_ip') THEN
    ALTER TABLE public.bookings ADD COLUMN guest_ip TEXT;
  END IF;
END $$;

-- ============================================================================
-- 2. CREATE INDEXES FOR PERFORMANCE
-- ============================================================================

-- Indexes for bookings table
CREATE INDEX IF NOT EXISTS idx_bookings_event_type_id ON public.bookings(event_type_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON public.bookings(start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON public.bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_guest_email ON public.bookings(guest_email);
CREATE INDEX IF NOT EXISTS idx_bookings_guest_ip ON public.bookings(guest_ip);
CREATE INDEX IF NOT EXISTS idx_bookings_event_type_ip ON public.bookings(event_type_id, guest_ip);

-- Indexes for event_types table
CREATE INDEX IF NOT EXISTS idx_event_types_user_id ON public.event_types(user_id);
CREATE INDEX IF NOT EXISTS idx_event_types_slug ON public.event_types(slug);
CREATE INDEX IF NOT EXISTS idx_event_types_is_active ON public.event_types(is_active);
CREATE INDEX IF NOT EXISTS idx_event_types_booking_limit ON public.event_types(booking_limit) WHERE booking_limit IS NOT NULL;

-- Indexes for users table
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);

-- ============================================================================
-- 3. ENABLE ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. CREATE RLS POLICIES
-- ============================================================================

-- Drop existing policies if they exist (for clean setup)
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.users;
DROP POLICY IF EXISTS "Public can view user profiles for booking" ON public.users;

DROP POLICY IF EXISTS "Users can view own event types" ON public.event_types;
DROP POLICY IF EXISTS "Anyone can view active event types" ON public.event_types;
DROP POLICY IF EXISTS "Public can view active event types with user info" ON public.event_types;
DROP POLICY IF EXISTS "Users can create own event types" ON public.event_types;
DROP POLICY IF EXISTS "Users can update own event types" ON public.event_types;
DROP POLICY IF EXISTS "Users can delete own event types" ON public.event_types;

DROP POLICY IF EXISTS "Event owners can view bookings" ON public.bookings;
DROP POLICY IF EXISTS "Anyone can create bookings" ON public.bookings;
DROP POLICY IF EXISTS "Event owners can update bookings" ON public.bookings;

-- ============================================================================
-- USERS TABLE POLICIES
-- ============================================================================

-- Users can view their own profile
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING (auth.uid() = id);

-- Users can insert their own profile
CREATE POLICY "Users can insert own profile" ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- 🎯 PUBLIC ACCESS: Allow anyone to view user profiles (needed for booking pages)
CREATE POLICY "Public can view user profiles for booking" ON public.users
  FOR SELECT USING (true);

-- ============================================================================
-- EVENT_TYPES TABLE POLICIES
-- ============================================================================

-- Users can view their own event types
CREATE POLICY "Users can view own event types" ON public.event_types
  FOR SELECT USING (auth.uid() = user_id);

-- 🎯 PUBLIC ACCESS: Anyone can view active event types (needed for booking pages)
CREATE POLICY "Public can view active event types with user info" ON public.event_types
  FOR SELECT USING (is_active = true);

-- Users can create their own event types
CREATE POLICY "Users can create own event types" ON public.event_types
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own event types
CREATE POLICY "Users can update own event types" ON public.event_types
  FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own event types
CREATE POLICY "Users can delete own event types" ON public.event_types
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- BOOKINGS TABLE POLICIES
-- ============================================================================

-- Event owners can view bookings for their events
CREATE POLICY "Event owners can view bookings" ON public.bookings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.event_types 
      WHERE event_types.id = bookings.event_type_id 
      AND event_types.user_id = auth.uid()
    )
  );

-- 🎯 PUBLIC ACCESS: Anyone can create bookings (needed for public booking)
CREATE POLICY "Anyone can create bookings" ON public.bookings
  FOR INSERT WITH CHECK (true);

-- Event owners can update bookings for their events
CREATE POLICY "Event owners can update bookings" ON public.bookings
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.event_types 
      WHERE event_types.id = bookings.event_type_id 
      AND event_types.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 5. CREATE HELPFUL FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers to automatically update updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON public.users 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_event_types_updated_at ON public.event_types;
CREATE TRIGGER update_event_types_updated_at 
    BEFORE UPDATE ON public.event_types 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bookings_updated_at ON public.bookings;
CREATE TRIGGER update_bookings_updated_at 
    BEFORE UPDATE ON public.bookings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 6. BOOKING LIMIT FUNCTIONALITY
-- ============================================================================

-- Function to update booking count when a booking is created
CREATE OR REPLACE FUNCTION update_booking_count()
RETURNS TRIGGER AS $$
BEGIN
  -- Only update count for confirmed bookings
  IF NEW.status = 'confirmed' THEN
    UPDATE event_types 
    SET booking_count = booking_count + 1
    WHERE id = NEW.event_type_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update booking count
DROP TRIGGER IF EXISTS trigger_update_booking_count ON public.bookings;
CREATE TRIGGER trigger_update_booking_count
  AFTER INSERT ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_booking_count();

-- Function to decrease booking count when a booking is cancelled
CREATE OR REPLACE FUNCTION decrease_booking_count()
RETURNS TRIGGER AS $$
BEGIN
  -- Decrease count when booking is cancelled
  IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN
    UPDATE event_types 
    SET booking_count = GREATEST(booking_count - 1, 0)
    WHERE id = OLD.event_type_id;
  -- Increase count when booking is reconfirmed
  ELSIF OLD.status = 'cancelled' AND NEW.status = 'confirmed' THEN
    UPDATE event_types 
    SET booking_count = booking_count + 1
    WHERE id = OLD.event_type_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for booking status changes
DROP TRIGGER IF EXISTS trigger_booking_status_change ON public.bookings;
CREATE TRIGGER trigger_booking_status_change
  AFTER UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION decrease_booking_count();

-- ============================================================================
-- 7. UPDATE EXISTING DATA (FOR MIGRATIONS)
-- ============================================================================

-- Update existing event types to use their user's timezone if not set
UPDATE event_types 
SET timezone = users.timezone 
FROM users 
WHERE event_types.user_id = users.id 
AND event_types.timezone IS NULL;

-- ============================================================================
-- 8. ADD COLUMN COMMENTS
-- ============================================================================

-- Add comments to explain columns
COMMENT ON COLUMN bookings.guest_timezone IS 'Timezone of the guest when they made the booking, used for display purposes';
COMMENT ON COLUMN bookings.guest_ip IS 'IP address of the guest when booking was made, used for abuse prevention';
COMMENT ON COLUMN event_types.timezone IS 'Host timezone for this event type, used for Google Calendar integration';
COMMENT ON COLUMN event_types.booking_limit IS 'Maximum number of bookings allowed for this event type. NULL means unlimited.';
COMMENT ON COLUMN event_types.booking_count IS 'Current number of confirmed bookings for this event type.';

-- ============================================================================
-- SETUP COMPLETE! 🎉
-- ============================================================================

-- Your v0 Calendar database is now ready to use!
-- 
-- This consolidated script includes:
-- ✅ Complete database schema
-- ✅ Guest timezone tracking
-- ✅ Host timezone for event types
-- ✅ Booking limits functionality
-- ✅ Guest IP tracking for abuse prevention
-- ✅ All necessary indexes and triggers
-- ✅ Row Level Security policies
-- ✅ Migration support for existing installations
-- 
-- Next steps:
-- 1. Set up your Google OAuth credentials in your environment variables
-- 2. Deploy your Next.js application
-- 3. Sign up through your app to create your first user
-- 4. Create your first event type
-- 5. Start accepting bookings!
--
-- Required environment variables:
-- - GOOGLE_CLIENT_ID
-- - GOOGLE_CLIENT_SECRET
-- - NEXT_PUBLIC_SUPABASE_URL
-- - NEXT_PUBLIC_SUPABASE_ANON_KEY
-- - SUPABASE_SERVICE_ROLE_KEY

SELECT 'v0 Calendar database setup completed successfully! 🚀' as status;
