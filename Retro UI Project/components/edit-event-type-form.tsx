"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { updateEventTypeBySlug, checkSlugAvailability } from "@/lib/actions/event-types"
import { AvailabilitySettingsV2 } from "./availability-settings-v2"
import { Check, X, Loader2 } from "lucide-react"
import type { Availability, EventType } from "@/types"
import { cn } from "@/lib/utils"

interface EditEventTypeFormProps {
  eventType: EventType & { user_name: string }
}

export function EditEventTypeForm({ eventType }: EditEventTypeFormProps) {
  const router = useRouter()
  const [title, setTitle] = useState(eventType.title)
  const [slug, setSlug] = useState(eventType.slug)
  const [duration, setDuration] = useState(eventType.duration.toString())
  const [availability, setAvailability] = useState<Availability>(eventType.availability)
  // Added booking limit state
  const [bookingLimit, setBookingLimit] = useState(eventType.booking_limit?.toString() || "")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken">("idle")

  // Check slug availability
  useEffect(() => {
    if (!slug || slug === eventType.slug) {
      setSlugStatus("idle")
      return
    }

    const timeoutId = setTimeout(async () => {
      setSlugStatus("checking")
      try {
        const isAvailable = await checkSlugAvailability(slug)
        setSlugStatus(isAvailable ? "available" : "taken")
      } catch (error) {
        setSlugStatus("idle")
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [slug, eventType.slug])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!title || !slug || !duration) {
      setError("Please fill in all required fields")
      return
    }

    if (slugStatus === "taken") {
      setError("Please choose a different URL")
      return
    }

    setIsSubmitting(true)
    setError("")

    try {
      const formData = new FormData()
      formData.append("title", title)
      formData.append("slug", slug)
      formData.append("duration", duration)
      formData.append("availability", JSON.stringify(availability))
      // Added booking limit to form data
      if (bookingLimit) {
        formData.append("bookingLimit", bookingLimit)
      }

      const result = await updateEventTypeBySlug(eventType.slug, formData)

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

  const getSlugIcon = () => {
    switch (slugStatus) {
      case "checking":
        return <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      case "available":
        return <Check className="h-4 w-4 text-green-500" />
      case "taken":
        return <X className="h-4 w-4 text-red-500" />
      default:
        return null
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="title">Event Name</Label>
        <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="duration">Duration (in minutes)</Label>
        <Select value={duration} onValueChange={setDuration}>
          <SelectTrigger>
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
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">Event URL</Label>
        <div className="flex items-center">
          <span className="px-3 py-2 bg-muted text-muted-foreground border-2 border-r-0 font-mono text-sm whitespace-nowrap">
            your-link.com/{eventType.user_name}/
          </span>
          <div className="relative flex-1">
            <Input
              id="slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              className={cn(
                "rounded-l-none pr-8",
                slugStatus === "available" && "border-green-500 focus-visible:ring-green-500",
                slugStatus === "taken" && "border-red-500 focus-visible:ring-red-500",
              )}
              required
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2">{getSlugIcon()}</div>
          </div>
        </div>
        {slugStatus === "taken" && <p className="text-sm text-red-600">This URL is already taken</p>}
        {slugStatus === "available" && <p className="text-sm text-green-600">URL is available</p>}
      </div>

      {/* Added booking limit field */}
      <div className="space-y-2">
        <Label htmlFor="bookingLimit">Booking Limit (optional)</Label>
        <Input
          id="bookingLimit"
          type="number"
          min="1"
          max="1000"
          value={bookingLimit}
          onChange={(e) => setBookingLimit(e.target.value)}
          placeholder="No limit"
        />
        <p className="text-sm text-muted-foreground">
          Maximum number of bookings allowed for this event type. Leave empty for no limit.
        </p>
      </div>

      <AvailabilitySettingsV2 availability={availability} onChange={setAvailability} />

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isSubmitting || slugStatus === "taken" || slugStatus === "checking"}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </form>
  )
}
