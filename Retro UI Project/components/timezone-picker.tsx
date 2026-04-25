"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Check, ChevronDown, Globe, MapPin } from "lucide-react"
import { cn } from "@/lib/utils"
import { getTimezoneDisplayName, detectTimezoneFromLocation } from "@/lib/utils/timezone"

const TIMEZONE_GROUPS = [
  {
    label: "North America",
    timezones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Phoenix",
      "America/Anchorage",
      "Pacific/Honolulu",
      "America/Toronto",
      "America/Vancouver",
    ],
  },
  {
    label: "South America",
    timezones: [
      "America/Argentina/Buenos_Aires",
      "America/Argentina/Cordoba",
      "America/Sao_Paulo",
      "America/Lima",
      "America/Bogota",
      "America/Caracas",
      "America/Santiago",
    ],
  },
  {
    label: "Europe",
    timezones: [
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Europe/Madrid",
      "Europe/Rome",
      "Europe/Amsterdam",
      "Europe/Stockholm",
      "Europe/Moscow",
    ],
  },
  {
    label: "Asia",
    timezones: [
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Asia/Kolkata",
      "Asia/Dubai",
      "Asia/Singapore",
      "Asia/Seoul",
      "Asia/Bangkok",
      "Asia/Manila",
    ],
  },
  {
    label: "Australia & Pacific",
    timezones: ["Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Pacific/Auckland", "Pacific/Fiji"],
  },
  {
    label: "Africa",
    timezones: ["Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi"],
  },
]

interface TimezonePickerProps {
  value: string
  onChange: (timezone: string) => void
  compact?: boolean
  disabled?: boolean
}

export function TimezonePicker({ value, onChange, compact = false, disabled = false }: TimezonePickerProps) {
  const [open, setOpen] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)
  // Fixed: Remove separate currentValue state to prevent sync issues
  // const [currentValue, setCurrentValue] = useState(value)

  // Removed useEffect that was causing sync issues
  // useEffect(() => {
  //   setCurrentValue(value)
  // }, [value])

  const handleAutoDetect = async () => {
    setIsDetecting(true)
    try {
      const detectedTimezone = await detectTimezoneFromLocation()
      if (detectedTimezone && detectedTimezone !== value) {
        // Fixed: Call onChange directly with detected timezone
        onChange(detectedTimezone)
      }
    } catch (error) {
      console.error("Auto-detect failed:", error)
    } finally {
      setIsDetecting(false)
    }
  }

  const handleSelect = (timezone: string) => {
    // Fixed: Call onChange directly and close popup
    onChange(timezone)
    setOpen(false)
  }

  const getDisplayValue = () => {
    if (!value) return "Select timezone..."

    try {
      return getTimezoneDisplayName(value)
    } catch (error) {
      return value
    }
  }

  // Function to get unique timezones by UTC offset
  const getUniqueTimezonesByOffset = (timezones: string[]) => {
    const seen = new Set<string>()
    return timezones.filter((timezone) => {
      const utcDisplay = getTimezoneDisplayName(timezone)
      if (seen.has(utcDisplay)) {
        return false
      }
      seen.add(utcDisplay)
      return true
    })
  }

  // Get unique timezones for each group
  const uniqueTimezoneGroups = TIMEZONE_GROUPS.map((group) => ({
    ...group,
    timezones: getUniqueTimezonesByOffset(group.timezones),
  })).filter((group) => group.timezones.length > 0) // Remove empty groups

  const allTimezones = TIMEZONE_GROUPS.flatMap((group) => group.timezones)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "justify-between font-normal",
            compact ? "h-8 text-xs px-2" : "w-full",
            disabled && "opacity-50 cursor-not-allowed",
          )}
          disabled={disabled}
        >
          <div className="flex items-center space-x-2">
            <Globe className={cn("shrink-0", compact ? "h-3 w-3" : "h-4 w-4")} />
            <span className="truncate">{getDisplayValue()}</span>
          </div>
          <ChevronDown className={cn("shrink-0 opacity-50", compact ? "h-3 w-3" : "h-4 w-4")} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <Command>
          {/* Auto-detect button at top */}
          <div className="flex items-center justify-center border-b p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleAutoDetect}
              disabled={isDetecting}
              className="h-8 px-3"
            >
              <MapPin className="h-3 w-3 mr-2" />
              {isDetecting ? "Detecting..." : "Auto Detect"}
            </Button>
          </div>
          <CommandList className="max-h-80">
            <CommandEmpty>No timezone found.</CommandEmpty>

            {/* Show current selection if it's not in our predefined list */}
            {value && !allTimezones.includes(value) && (
              <CommandGroup heading="Current">
                <CommandItem
                  value={value}
                  onSelect={() => handleSelect(value)}
                  className="flex items-center justify-between"
                >
                  <span>{getTimezoneDisplayName(value)}</span>
                  <Check className={cn("h-4 w-4", "opacity-100")} />
                </CommandItem>
              </CommandGroup>
            )}

            {/* Show unique timezones grouped by region */}
            {uniqueTimezoneGroups.map((group) => (
              <CommandGroup key={group.label} heading={group.label}>
                {group.timezones.map((timezone) => (
                  <CommandItem
                    key={timezone}
                    value={timezone}
                    onSelect={() => handleSelect(timezone)}
                    className="flex items-center justify-between"
                  >
                    <span>{getTimezoneDisplayName(timezone)}</span>
                    {/* Fixed: Use value prop directly for comparison */}
                    <Check className={cn("h-4 w-4", value === timezone ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
