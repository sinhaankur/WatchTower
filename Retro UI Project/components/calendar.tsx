"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  format,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  isSameDay,
  isBefore,
  startOfDay,
  startOfWeek,
  endOfWeek,
} from "date-fns"
import { cn } from "@/lib/utils"
import { getAvailableTimeSlots } from "@/lib/availability"
import { getUserTimezone, detectTimezoneFromLocation, setUserTimezone } from "@/lib/utils/timezone"
import { TimezonePicker } from "./timezone-picker"
import { BookingForm } from "./booking-form"
import { TimeWheelPicker } from "./time-wheel-picker"
import { useMobile } from "@/hooks/use-mobile"

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

interface CalendarProps {
  selectedDate?: Date
  onDateSelect?: (date: Date) => void
  availableDates?: Date[]
  className?: string
  onDateTimeSelect?: (date: string, time: string) => void
  eventTypeId?: string
  ownerTimezone?: string
  eventTitle?: string
  duration?: number
  hostName?: string
  hostAvatar?: string
  hostFullName?: string
}

export function Calendar({
  selectedDate,
  onDateSelect,
  availableDates = [],
  className,
  onDateTimeSelect,
  eventTypeId,
  ownerTimezone = "America/New_York",
  eventTitle = "Meeting",
  duration = 30,
  hostName = "Host",
  hostAvatar,
  hostFullName,
}: CalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDateState, setSelectedDateState] = useState<Date | null>(selectedDate || null)
  const [selectedTimeState, setSelectedTimeState] = useState<string | null>(null)
  const [showTimeSelection, setShowTimeSelection] = useState(false)
  const [availableTimeSlots, setAvailableTimeSlots] = useState<string[]>([])
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [userTimezone, setUserTimezoneState] = useState(getUserTimezone())
  const [showBookingForm, setShowBookingForm] = useState(false)
  const [isNavigating, setIsNavigating] = useState(false)
  const [selectedTimeSlot, setSelectedTimeSlot] = useState<string | null>(null)
  const [hasDetectedTimezone, setHasDetectedTimezone] = useState(false)

  const isMobile = useMobile()

  // Enhanced: Auto-detect timezone on component mount
  useEffect(() => {
    const autoDetectTimezone = async () => {
      if (hasDetectedTimezone) return

      try {
        // Only auto-detect if user hasn't manually set a timezone
        const savedTimezone = localStorage.getItem("user-timezone")
        if (!savedTimezone) {
          console.log(`🌍 [CALENDAR] Auto-detecting timezone...`)
          const detectedTimezone = await detectTimezoneFromLocation()
          if (detectedTimezone && detectedTimezone !== userTimezone) {
            console.log(`🌍 [CALENDAR] Auto-detected timezone: ${detectedTimezone}`)
            setUserTimezoneState(detectedTimezone)
            setUserTimezone(detectedTimezone) // Save to localStorage
          }
        }
      } catch (error) {
        console.error("Auto timezone detection failed:", error)
      } finally {
        setHasDetectedTimezone(true)
      }
    }

    autoDetectTimezone()
  }, [hasDetectedTimezone, userTimezone])

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 0 }) // Sunday = 0
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd })

  const previousMonth = async () => {
    // Prevent multiple rapid clicks
    if (isNavigating) return

    setIsNavigating(true)
    setCurrentMonth(subMonths(currentMonth, 1))
    setTimeout(() => setIsNavigating(false), 200)
  }

  const nextMonth = async () => {
    // Prevent multiple rapid clicks
    if (isNavigating) return

    setIsNavigating(true)
    setCurrentMonth(addMonths(currentMonth, 1))
    setTimeout(() => setIsNavigating(false), 200)
  }

  const isDateAvailable = (date: Date) => {
    if (availableDates.length > 0) {
      return availableDates.some((availableDate) => isSameDay(date, availableDate))
    }
    return !isBefore(date, startOfDay(new Date()))
  }

  const isDateSelected = (date: Date) => {
    return selectedDateState ? isSameDay(date, selectedDateState) : false
  }

  // Fixed: Accept timezone parameter to avoid stale state issues
  const fetchFreshAvailability = async (date: Date, timezone?: string) => {
    if (!eventTypeId) return

    // Use provided timezone or current state
    const targetTimezone = timezone || userTimezone

    setLoadingSlots(true)

    try {
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, "0")
      const day = String(date.getDate()).padStart(2, "0")
      const dateStr = `${year}-${month}-${day}`

      console.log(`🔍 [CALENDAR] Fetching availability for: ${dateStr} in timezone: ${targetTimezone}`)

      // Pass the guest's timezone to get slots in their timezone
      const slots = await getAvailableTimeSlots(eventTypeId, dateStr, targetTimezone)
      setAvailableTimeSlots(slots)

      console.log(`✅ [CALENDAR] Received ${slots.length} available slots in guest timezone:`, slots)
    } catch (error) {
      console.error("Error fetching available slots:", error)
      setAvailableTimeSlots([])
    } finally {
      setLoadingSlots(false)
    }
  }

  const handleDateSelect = (date: Date) => {
    setSelectedDateState(date)
    setSelectedTimeState(null)
    setShowTimeSelection(true)
    fetchFreshAvailability(date)
  }

  const handleTimeSelect = async (time: string) => {
    if (selectedTimeSlot === time) return

    console.log(`🕐 [CALENDAR] User selected time: ${time} (in ${userTimezone})`)

    setSelectedTimeSlot(time)
    setSelectedTimeState(time)

    if (selectedDateState) {
      const year = selectedDateState.getFullYear()
      const month = String(selectedDateState.getMonth() + 1).padStart(2, "0")
      const day = String(selectedDateState.getDate()).padStart(2, "0")
      const dateStr = `${year}-${month}-${day}`

      console.log(`📅 [CALENDAR] Selected date-time: ${dateStr} ${time} (guest timezone: ${userTimezone})`)

      onDateTimeSelect && onDateTimeSelect(dateStr, time)

      if (!isMobile) {
        setTimeout(() => {
          setShowBookingForm(true)
          setSelectedTimeSlot(null)
        }, 300)
      } else {
        setShowBookingForm(true)
        setSelectedTimeSlot(null)
      }
    }
  }

  const handleBackToCalendar = () => {
    setShowTimeSelection(false)
    setSelectedTimeState(null)
    setSelectedDateState(null)
    setAvailableTimeSlots([])
    setSelectedTimeSlot(null)
  }

  const handleBackToTimeSelection = () => {
    setShowBookingForm(false)
    setSelectedTimeSlot(null)
  }

  const formatSelectedDateShort = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  }

  // Updated: Now times are already in guest timezone, so just format them nicely
  const formatTimeInUserTimezone = (time: string, date: Date) => {
    try {
      const [hours, minutes] = time.split(":").map(Number)
      const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours
      const ampm = hours < 12 ? "AM" : "PM"
      return `${hour12}:${minutes.toString().padStart(2, "0")} ${ampm}`
    } catch (error) {
      console.error("Error formatting time:", error)
      return time
    }
  }

  // Fixed: Pass new timezone directly to avoid stale state
  const handleTimezoneChange = (newTimezone: string) => {
    console.log(`🌍 [CALENDAR] Timezone changed from ${userTimezone} to: ${newTimezone}`)

    // Update state immediately
    setUserTimezoneState(newTimezone)
    setUserTimezone(newTimezone) // Save to localStorage

    // Refresh availability with the NEW timezone (not the stale state)
    if (selectedDateState) {
      console.log(`🔄 [CALENDAR] Refreshing availability with new timezone: ${newTimezone}`)
      fetchFreshAvailability(selectedDateState, newTimezone)
    }
  }

  return (
    <Card className={cn("shadow-lg border-2 w-full max-w-2xl mx-auto no-scrollbar", className)}>
      <CardHeader className="text-center space-y-3 border-b-2 p-6">
        {!showTimeSelection && !showBookingForm ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center space-x-4">
              <Avatar className="h-12 w-12 border-2 shadow-md">
                <AvatarImage src={hostAvatar || "/placeholder.svg"} alt={hostFullName} />
                <AvatarFallback className="text-lg font-bold bg-primary/10 text-primary">
                  {hostFullName?.charAt(0)}
                </AvatarFallback>
              </Avatar>

              <div className="text-left">
                <div className="flex items-center space-x-2">
                  <h1 className="text-xl font-bold">{eventTitle}</h1>
                  <span className="text-muted-foreground">•</span>
                  <span className="text-sm text-muted-foreground font-medium">{duration}min</span>
                </div>
                <p className="text-sm text-muted-foreground">with {hostFullName}</p>
              </div>
            </div>

            <div className="flex items-center justify-center space-x-2 text-xs text-muted-foreground">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span>Available for booking</span>
            </div>
          </div>
        ) : showTimeSelection && !showBookingForm ? (
          <div className="space-y-2">
            <CardTitle className="text-base sm:text-lg font-bold leading-tight">
              Perfect! Pick a time for {selectedDateState && formatSelectedDateShort(selectedDateState)}
            </CardTitle>
            {/* Added timezone indicator for clarity */}
            <p className="text-xs text-muted-foreground">Times shown in your timezone ({userTimezone})</p>
          </div>
        ) : showBookingForm ? (
          <div className="space-y-2">
            <CardTitle className="text-base sm:text-lg font-bold leading-tight">
              Almost there! Just need a few details
            </CardTitle>
          </div>
        ) : null}
      </CardHeader>

      {/* Fixed: Added no-scrollbar class and removed potential overflow issues */}
      <CardContent className="p-4 no-scrollbar">
        {!showTimeSelection ? (
          <div className="space-y-4 no-scrollbar">
            <div className="flex items-center justify-between">
              <Button
                variant="outline"
                size="icon"
                onClick={previousMonth}
                className="h-9 w-9 bg-transparent"
                disabled={isNavigating}
              >
                {isNavigating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronLeft className="h-4 w-4" />}
              </Button>
              <h3 className="text-base font-bold">{format(currentMonth, "MMMM yyyy")}</h3>
              <Button
                variant="outline"
                size="icon"
                onClick={nextMonth}
                className="h-9 w-9 bg-transparent"
                disabled={isNavigating}
              >
                {isNavigating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
              </Button>
            </div>

            {/* Fixed: Removed any potential overflow from calendar grid */}
            <div className="no-scrollbar">
              <div className="grid grid-cols-7 gap-1 mb-3">
                {DAYS.map((day) => (
                  <div
                    key={day}
                    className="text-center text-xs font-bold text-muted-foreground h-10 flex items-center justify-center"
                  >
                    {day}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1 no-scrollbar">
                {days.map((day) => {
                  const isCurrentMonth = isSameMonth(day, currentMonth)
                  const isAvailable = isDateAvailable(day)
                  const isSelected = isDateSelected(day)
                  const isTodayDate = isToday(day)
                  const isPastDate = isBefore(day, startOfDay(new Date()))

                  return (
                    <Button
                      key={day.toISOString()}
                      variant={isSelected ? "default" : "ghost"}
                      size="icon"
                      className={cn(
                        "h-10 w-full font-bold text-sm transition-all duration-200 flex items-center justify-center",
                        !isCurrentMonth && "text-muted-foreground opacity-30",
                        isPastDate && "text-muted-foreground opacity-30 cursor-not-allowed",
                        isTodayDate && !isSelected && "bg-secondary/20 border-2 border-secondary",
                        isCurrentMonth && isAvailable && !isPastDate
                          ? "hover:bg-accent hover:scale-110"
                          : "cursor-not-allowed opacity-50",
                        isSelected && "shadow-lg scale-110",
                      )}
                      onClick={() => handleDateSelect(day)}
                      disabled={!isCurrentMonth || !isAvailable || isPastDate || isNavigating}
                    >
                      {format(day, "d")}
                    </Button>
                  )
                })}
              </div>
            </div>
          </div>
        ) : showBookingForm ? (
          <BookingForm
            eventTypeId={eventTypeId!}
            eventTitle={eventTitle}
            duration={duration}
            selectedDate={selectedDateState!}
            selectedTime={selectedTimeState!}
            onBack={handleBackToTimeSelection}
            userTimezone={userTimezone}
            hostName={hostName}
          />
        ) : (
          <div className="space-y-4 no-scrollbar">
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={handleBackToCalendar} className="bg-transparent text-sm">
                <ChevronLeft className="h-4 w-4 mr-2" />
                Choose a different date
              </Button>
              <TimezonePicker value={userTimezone} onChange={handleTimezoneChange} compact={true} />
            </div>

            {loadingSlots ? (
              <div className="text-center py-8">
                <Loader2 className="animate-spin h-6 w-6 text-primary mx-auto mb-3" />
                <p className="text-base font-medium">Finding the perfect times...</p>
                <p className="text-muted-foreground text-xs mt-1">This will just take a moment</p>
              </div>
            ) : availableTimeSlots.length === 0 ? (
              <div className="text-center py-8 space-y-3">
                <div>
                  <p className="text-base font-semibold">No times available</p>
                  <p className="text-muted-foreground text-xs mt-1">
                    {hostName} doesn't have any open slots on this date. Try picking another day!
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3 no-scrollbar">
                {isMobile ? (
                  <TimeWheelPicker
                    availableTimeSlots={availableTimeSlots}
                    selectedTime={selectedTimeState}
                    onTimeSelect={handleTimeSelect}
                    formatTime={(time) => formatTimeInUserTimezone(time, selectedDateState!)}
                  />
                ) : (
                  <div className="grid grid-cols-3 md:grid-cols-4 gap-2 no-scrollbar">
                    {availableTimeSlots.map((time) => {
                      const userTime = formatTimeInUserTimezone(time, selectedDateState!)
                      const isTimeSelected = selectedTimeSlot === time

                      return (
                        <Button
                          key={time}
                          variant="outline"
                          onClick={() => handleTimeSelect(time)}
                          disabled={isTimeSelected}
                          className={cn(
                            "h-10 text-xs font-bold transition-all duration-200 text-center px-2 bg-transparent",
                            "hover:border-primary hover:bg-primary/10 hover:text-foreground hover:scale-105",
                            isTimeSelected && "opacity-50 cursor-not-allowed",
                          )}
                        >
                          {isTimeSelected ? <Loader2 className="h-3 w-3 animate-spin" /> : userTime}
                        </Button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
