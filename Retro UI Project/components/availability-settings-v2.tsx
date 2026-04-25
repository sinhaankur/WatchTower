"use client"

import { useState, useEffect } from "react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Plus, Trash2, Copy } from "lucide-react"
import { TimezonePicker } from "./timezone-picker"
import { getUserTimezone, detectTimezoneFromLocation } from "@/lib/utils/timezone"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { Availability as AvailabilityData } from "@/types"

const DAYS = [
  { key: "monday", label: "Mon", fullLabel: "Monday" },
  { key: "tuesday", label: "Tue", fullLabel: "Tuesday" },
  { key: "wednesday", label: "Wed", fullLabel: "Wednesday" },
  { key: "thursday", label: "Thu", fullLabel: "Thursday" },
  { key: "friday", label: "Fri", fullLabel: "Friday" },
  { key: "saturday", label: "Sat", fullLabel: "Saturday" },
  { key: "sunday", label: "Sun", fullLabel: "Sunday" },
] as const

const DEFAULT_AVAILABILITY: AvailabilityData = {
  monday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  tuesday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  wednesday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  thursday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  friday: { enabled: true, slots: [{ start: "09:00", end: "17:00" }] },
  saturday: { enabled: false, slots: [] },
  sunday: { enabled: false, slots: [] },
  timezone: getUserTimezone(),
}

interface AvailabilitySettingsV2Props {
  availability: AvailabilityData
  onChange: (availability: AvailabilityData) => void
}

export function AvailabilitySettingsV2({ availability, onChange }: AvailabilitySettingsV2Props) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)

  // Auto-detect timezone on mount if using default
  useEffect(() => {
    const autoDetectTimezone = async () => {
      if (!availability.timezone || availability.timezone === "America/New_York") {
        setIsDetecting(true)
        try {
          const detectedTimezone = await detectTimezoneFromLocation()
          if (detectedTimezone && detectedTimezone !== availability.timezone) {
            const newAvailability = { ...availability, timezone: detectedTimezone }
            onChange(newAvailability)
          }
        } catch (error) {
          // Silent fallback
        } finally {
          setIsDetecting(false)
        }
      }
    }

    autoDetectTimezone()
  }, [])

  const updateAvailability = (newAvailability: AvailabilityData) => {
    onChange(newAvailability)
  }

  const toggleDay = (dayKey: keyof Omit<AvailabilityData, "timezone">) => {
    const newAvailability = {
      ...availability,
      [dayKey]: {
        ...availability[dayKey],
        enabled: !availability[dayKey].enabled,
        slots: !availability[dayKey].enabled ? [{ start: "09:00", end: "17:00" }] : [],
      },
    }
    updateAvailability(newAvailability)
  }

  const addTimeSlot = (dayKey: keyof Omit<AvailabilityData, "timezone">) => {
    const newAvailability = {
      ...availability,
      [dayKey]: {
        ...availability[dayKey],
        slots: [...availability[dayKey].slots, { start: "09:00", end: "17:00" }],
      },
    }
    updateAvailability(newAvailability)
  }

  const removeTimeSlot = (dayKey: keyof Omit<AvailabilityData, "timezone">, slotIndex: number) => {
    const newAvailability = {
      ...availability,
      [dayKey]: {
        ...availability[dayKey],
        slots: availability[dayKey].slots.filter((_, index) => index !== slotIndex),
      },
    }
    updateAvailability(newAvailability)
  }

  const updateTimeSlot = (
    dayKey: keyof Omit<AvailabilityData, "timezone">,
    slotIndex: number,
    field: "start" | "end",
    value: string,
  ) => {
    const newAvailability = {
      ...availability,
      [dayKey]: {
        ...availability[dayKey],
        slots: availability[dayKey].slots.map((slot, index) =>
          index === slotIndex ? { ...slot, [field]: value } : slot,
        ),
      },
    }
    updateAvailability(newAvailability)
  }

  const updateTimezone = (timezone: string) => {
    const newAvailability = { ...availability, timezone }
    updateAvailability(newAvailability)
  }

  const copyToAllDays = (sourceDay: keyof Omit<AvailabilityData, "timezone">) => {
    const sourceConfig = availability[sourceDay]
    const newAvailability = { ...availability }

    DAYS.forEach(({ key }) => {
      if (key !== sourceDay) {
        newAvailability[key] = {
          enabled: sourceConfig.enabled,
          slots: sourceConfig.slots.map((slot) => ({ ...slot })),
        }
      }
    })

    updateAvailability(newAvailability)
  }

  const enabledDays = DAYS.filter(({ key }) => availability[key].enabled)

  return (
    <div className="space-y-6">
      {/* Timezone Section */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium">Timezone</h4>
          {/* Shortened description text */}
          <p className="text-xs text-muted-foreground mt-1">Your timezone for availability and bookings.</p>
        </div>
        <TimezonePicker value={availability.timezone} onChange={updateTimezone} compact={true} disabled={isDetecting} />
      </div>

      {/* Schedule Summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-center space-x-2 mb-3">
          <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
          <h4 className="font-medium text-blue-900">Your Schedule</h4>
        </div>

        {enabledDays.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 text-sm text-blue-800">
            {enabledDays.map(({ fullLabel, key }) => {
              const slots = availability[key].slots
              const timeRange = slots.length === 1 ? `${slots[0].start}-${slots[0].end}` : `${slots.length} slots`
              return (
                <div key={key}>
                  <span className="font-medium">{fullLabel}</span>: {timeRange}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-blue-600">No available days selected</p>
        )}
      </div>

      {/* Quick Toggle */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Weekly Schedule</h4>
        <div className="grid grid-cols-7 gap-2">
          {DAYS.map(({ key, label }) => (
            <div key={key} className="text-center">
              <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
              <Button
                type="button"
                variant={availability[key].enabled ? "default" : "outline"}
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => toggleDay(key)}
              >
                {availability[key].enabled ? "On" : "Off"}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Detailed Customization */}
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="flex justify-end">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="text-xs">
              {isExpanded ? "Collapse" : "Customize"}
            </Button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="space-y-3 mt-3">
          {DAYS.map(({ key, fullLabel }) => (
            <div key={key} className="py-2">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-3">
                  <Switch checked={availability[key].enabled} onCheckedChange={() => toggleDay(key)} />
                  <span className="font-medium text-sm">{fullLabel}</span>
                </div>
                {availability[key].enabled && availability[key].slots.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToAllDays(key)}
                    className="h-7 text-xs"
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy to all
                  </Button>
                )}
              </div>
              {availability[key].enabled && (
                <div className="space-y-2 ml-8">
                  {availability[key].slots.map((slot, slotIndex) => (
                    <div key={slotIndex} className="flex items-center space-x-2">
                      {/* Fixed: Increased width from w-16 to w-20 to show full time */}
                      <Input
                        type="time"
                        value={slot.start}
                        onChange={(e) => updateTimeSlot(key, slotIndex, "start", e.target.value)}
                        className="w-20 h-8 text-sm"
                      />
                      <span className="text-muted-foreground text-xs">to</span>
                      {/* Fixed: Increased width from w-16 to w-20 to show full time */}
                      <Input
                        type="time"
                        value={slot.end}
                        onChange={(e) => updateTimeSlot(key, slotIndex, "end", e.target.value)}
                        className="w-20 h-8 text-sm"
                      />
                      {availability[key].slots.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeTimeSlot(key, slotIndex)}
                          className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addTimeSlot(key)}
                    className="h-6 text-xs text-primary"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add time slot
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
