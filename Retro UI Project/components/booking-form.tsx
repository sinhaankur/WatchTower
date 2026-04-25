"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ArrowLeft, Loader2, Sparkles } from "lucide-react"
import { createBooking } from "@/lib/actions/bookings"
import { useRouter } from "next/navigation"

interface BookingFormProps {
  eventTypeId: string
  eventTitle: string
  duration: number
  selectedDate: Date
  selectedTime: string
  onBack: () => void
  userTimezone: string
  hostName?: string
}

export function BookingForm({
  eventTypeId,
  eventTitle,
  duration,
  selectedDate,
  selectedTime,
  onBack,
  userTimezone,
  hostName = "Host",
}: BookingFormProps) {
  const [guestName, setGuestName] = useState("")
  const [guestEmail, setGuestEmail] = useState("")
  const [notes, setNotes] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [csrfToken, setCsrfToken] = useState("")
  const router = useRouter()

  // Get CSRF token on component mount
  useEffect(() => {
    async function fetchCSRFToken() {
      try {
        const response = await fetch("/api/csrf-token")
        const data = await response.json()
        setCsrfToken(data.token)
      } catch (error) {
        console.error("Failed to get CSRF token:", error)
      }
    }

    fetchCSRFToken()
  }, [])

  // Format the selected date and time for display
  const formatSelectedDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })
  }

  const formatSelectedTime = (time: string, date: Date) => {
    try {
      const [hours, minutes] = time.split(":").map(Number)
      const dateTime = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes)

      return dateTime.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    } catch (error) {
      console.error("Error formatting time:", error)
      return time
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Prevent double submission
    if (isSubmitting) {
      return
    }

    if (!guestName.trim() || !guestEmail.trim()) {
      setError("Please fill in all required fields")
      return
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(guestEmail)) {
      setError("Please enter a valid email address")
      return
    }

    // Check if CSRF token is available
    if (!csrfToken) {
      setError("Security validation failed. Please refresh the page and try again.")
      return
    }

    setIsSubmitting(true)
    setError("")

    try {
      // Format date for the booking
      const year = selectedDate.getFullYear()
      const month = String(selectedDate.getMonth() + 1).padStart(2, "0")
      const day = String(selectedDate.getDate()).padStart(2, "0")
      const dateStr = `${year}-${month}-${day}`

      // Create FormData for the server action
      const formData = new FormData()
      formData.append("eventTypeId", eventTypeId)
      formData.append("guestName", guestName.trim())
      formData.append("guestEmail", guestEmail.trim())
      formData.append("selectedDate", dateStr)
      formData.append("selectedTime", selectedTime)
      formData.append("duration", duration.toString())
      formData.append("notes", notes.trim())
      formData.append("userTimezone", userTimezone)
      formData.append("csrf-token", csrfToken)

      const result = await createBooking(formData)

      if (result.error) {
        setError(result.error)
        setIsSubmitting(false)
      } else if (result.success && result.redirectUrl) {
        router.push(result.redirectUrl)
      } else {
        setError("Something went wrong. Please try again.")
        setIsSubmitting(false)
      }
    } catch (error) {
      console.error("Error creating booking:", error)
      setError("Failed to create booking. Please try again.")
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Simplified Meeting Summary - more compact */}
      <div className="bg-accent/5 border-2 border-accent/20 p-3 rounded-lg">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-accent/10 border-2 border-accent/30 flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-accent" />
          </div>
          <div className="flex-1">
            <p className="font-bold text-sm">{eventTitle}</p>
            <p className="text-xs text-muted-foreground">
              {formatSelectedDate(selectedDate)} at {formatSelectedTime(selectedTime, selectedDate)} • {duration} min
            </p>
          </div>
        </div>
      </div>

      {/* Simplified Booking Form - cleaner like new event type form */}
      <div className="bg-card border-2 p-6 shadow-sm">
        <div className="space-y-4">
          {/* Simplified header */}
          <div className="space-y-1">
            <h2 className="text-lg font-bold">Your Details</h2>
            <p className="text-sm text-muted-foreground">Tell us about yourself</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Name field - simplified */}
            <div className="space-y-2">
              <Label htmlFor="guestName" className="text-sm font-medium">
                Your Name *
              </Label>
              <Input
                id="guestName"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Enter your full name"
                required
                disabled={isSubmitting}
              />
            </div>

            {/* Email field - simplified */}
            <div className="space-y-2">
              <Label htmlFor="guestEmail" className="text-sm font-medium">
                Email Address *
              </Label>
              <Input
                id="guestEmail"
                type="email"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                placeholder="your.email@example.com"
                required
                disabled={isSubmitting}
              />
            </div>

            {/* Notes field - much smaller and simplified */}
            <div className="space-y-2">
              <Label htmlFor="notes" className="text-sm font-medium">
                Additional Notes (Optional)
              </Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything you'd like to share..."
                rows={2} // Reduced from 3 to 2 rows
                className="resize-none text-sm"
                disabled={isSubmitting}
              />
            </div>

            {/* Error message - simplified */}
            {error && (
              <div className="p-3 bg-destructive/10 border-2 border-destructive/20 text-destructive text-sm font-medium rounded-lg">
                {error}
              </div>
            )}

            {/* Action Buttons - simplified layout */}
            <div className="flex justify-end space-x-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={onBack}
                className="bg-transparent"
                disabled={isSubmitting}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Booking...
                  </>
                ) : (
                  "Confirm Meeting"
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
