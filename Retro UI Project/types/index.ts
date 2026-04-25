import type { User } from "@supabase/supabase-js"

// Extiende el usuario de Supabase con nuestros campos personalizados
export type AppUser = User & {
  user_name: string
  full_name: string
  avatar_url: string
  google_access_token?: string
  google_refresh_token?: string
  timezone?: string
}

// Define la estructura de los slots de tiempo
export interface TimeSlot {
  start: string
  end: string
}

// Define la disponibilidad para un día
export interface DayAvailability {
  enabled: boolean
  slots: TimeSlot[]
}

// Define la estructura completa de disponibilidad
export interface Availability {
  monday: DayAvailability
  tuesday: DayAvailability
  wednesday: DayAvailability
  thursday: DayAvailability
  friday: DayAvailability
  saturday: DayAvailability
  sunday: DayAvailability
  timezone?: string
}

// Define el tipo de evento
export interface EventType {
  id: string
  user_id: string
  title: string
  slug: string
  duration: number
  description: string | null
  is_active: boolean
  availability: Availability
  timezone: string | null
  created_at: string
  updated_at: string
  user: {
    id: string
    full_name: string
    username: string
    avatar_url: string
    timezone: string
    email: string
  }
}

// Define el tipo de reserva (booking)
export interface Booking {
  id: string
  event_type_id: string
  guest_name: string
  guest_email: string
  start_time: string
  end_time: string
  status: "confirmed" | "cancelled"
  notes: string | null
  created_at: string
  updated_at: string
}
