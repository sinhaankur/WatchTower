"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createEventType, checkSlugAvailability } from "@/lib/actions/event-types"
import { AvailabilitySettingsV2 } from "./availability-settings-v2"
import { Loader2, AlertCircle } from "lucide-react"
import type { Availability } from "@/types"
import { cn } from "@/lib/utils"

const DEFAULT_AVAILABILITY: Availability = {
  monday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  tuesday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  wednesday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  thursday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  friday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  saturday: { enabled: false, slots: [] },
  sunday: { enabled: false, slots: [] },
  timezone: "America/New_York",
}

interface NewEventTypeFormProps {
  userName: string
  baseUrl: string
}

export function NewEventTypeForm({ userName, baseUrl }: NewEventTypeFormProps) {
  const router = useRouter()
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [duration, setDuration] = useState("30")
  const [availability, setAvailability] = useState<Availability>(DEFAULT_AVAILABILITY)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  // Booking limit states
  const [bookingLimit, setBookingLimit] = useState<number | null>(null)

  const [fieldErrors, setFieldErrors] = useState<{
    title?: string
    duration?: string
  }>({})
  const [touched, setTouched] = useState<{
    title?: boolean
    duration?: boolean
  }>({})

  // Auto-generate slug from title
  useEffect(() => {
    if (title) {
      const generatedSlug = title
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 50)
      setSlug(generatedSlug)
    }
  }, [title])

  // Check slug availability in background
  useEffect(() => {
    if (!slug || slug.length < 2) return

    const timeoutId = setTimeout(async () => {
      try {
        await checkSlugAvailability(slug)
      } catch (error) {
        // Silent check
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [slug])

  const validateField = (fieldName: string, value: string) => {
    const errors: typeof fieldErrors = { ...fieldErrors }

    switch (fieldName) {
      case "title":
        if (!value.trim()) {
          errors.title = "Event title is required"
        } else if (value.trim().length < 3) {
          errors.title = "Event title must be at least 3 characters"
        } else {
          delete errors.title
        }
        break
      case "duration":
        if (!value) {
          errors.duration = "Duration is required"
        } else {
          delete errors.duration
        }
        break
    }

    setFieldErrors(errors)
  }

  const handleTitleBlur = () => {
    setTouched((prev) => ({ ...prev, title: true }))
    validateField("title", title)
  }

  const handleDurationChange = (value: string) => {
    setDuration(value)
    setTouched((prev) => ({ ...prev, duration: true }))
    validateField("duration", value)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Mark all fields as touched for validation display
    setTouched({ title: true, duration: true })

    // Validate all fields
    validateField("title", title)
    validateField("duration", duration)

    if (!title || !duration) {
      setError("Please fill in all required fields")
      return
    }

    // Check if there are any field errors
    if (Object.keys(fieldErrors).length > 0) {
      setError("Please fix the errors above")
      return
    }

    setIsSubmitting(true)
    setError("")

    try {
      const formData = new FormData()
      formData.append("title", title)
      formData.append("slug", slug)
      formData.append("duration", duration)
      formData.append("timezone", availability.timezone || "America/New_York")
      formData.append("availability", JSON.stringify(availability))

      // Add booking limit if set
      if (bookingLimit && bookingLimit > 0) {
        formData.append("bookingLimit", bookingLimit.toString())
      }

      const result = await createEventType(formData)

      if (result.error) {
        setError(result.error)
      } else {
        router.push("/")
        router.refresh()
      }
    } catch (error) {
      setError("Something went wrong. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    // Clean single form container like edit form
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      {/* Event Name */}
      <div className="space-y-2">
        <Label htmlFor="title" className="text-sm font-medium">
          Event Name
        </Label>
        <div className="space-y-2">
          <Input
            id="title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              if (touched.title) {
                validateField("title", e.target.value)
              }
            }}
            onBlur={handleTitleBlur}
            placeholder="e.g., 30 Minute Meeting"
            className={cn(
              touched.title &&
                fieldErrors.title &&
                "border-destructive bg-destructive/5 focus:border-destructive focus:ring-destructive/20",
            )}
            required
          />
          {touched.title && fieldErrors.title && (
            <div className="flex items-center space-x-2 text-destructive text-sm bg-destructive/10 border border-destructive/20 px-3 py-2 rounded-md">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="font-medium">{fieldErrors.title}</span>
            </div>
          )}
        </div>
      </div>

      {/* Duration */}
      <div className="space-y-2">
        <Label htmlFor="duration" className="text-sm font-medium">
          Duration (in minutes)
        </Label>
        <div className="space-y-2">
          <Select value={duration} onValueChange={handleDurationChange}>
            <SelectTrigger
              className={cn(
                touched.duration &&
                  fieldErrors.duration &&
                  "border-destructive bg-destructive/5 focus:border-destructive focus:ring-destructive/20",
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15">15 minutes</SelectItem>
              <SelectItem value="30">30 minutes</SelectItem>
              <SelectItem value="45">45 minutes</SelectItem>
              <SelectItem value="60">1 hour</SelectItem>
              <SelectItem value="90">1.5 hours</SelectItem>
              <SelectItem value="120">2 hours</SelectItem>
            </SelectContent>
          </Select>
          {touched.duration && fieldErrors.duration && (
            <div className="flex items-center space-x-2 text-destructive text-sm bg-destructive/10 border border-destructive/20 px-3 py-2 rounded-md">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="font-medium">{fieldErrors.duration}</span>
            </div>
          )}
        </div>
      </div>

      {/* Booking Limit */}
      <div className="space-y-2">
        <Label htmlFor="bookingLimit">Booking Limit (optional)</Label>
        <Input
          id="bookingLimit"
          type="number"
          min="1"
          max="1000"
          value={bookingLimit || ""}
          onChange={(e) => setBookingLimit(e.target.value ? Number.parseInt(e.target.value) : null)}
          placeholder="No limit"
        />
        <p className="text-sm text-muted-foreground">
          Maximum number of bookings allowed for this event type. Leave empty for no limit.
        </p>
      </div>

      {/* Timezone - simplified label without long description */}
      <AvailabilitySettingsV2 availability={availability} onChange={setAvailability} />

      {/* Error Message */}
      {error && (
        <div className="flex items-center space-x-3 p-4 bg-destructive/10 border-2 border-destructive/20 text-destructive rounded-lg">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <div>
            <p className="font-bold text-sm">Error</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex justify-end space-x-4 pt-6">
        <Button type="button" variant="outline" onClick={() => router.push("/")} className="bg-transparent">
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            "Create Event Type"
          )}
        </Button>
      </div>
    </form>
  )
}
