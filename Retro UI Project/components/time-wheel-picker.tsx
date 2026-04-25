"use client"

import type React from "react"

import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { TimezonePicker } from "./timezone-picker"
import { Loader2 } from "lucide-react"

interface TimeWheelPickerProps {
  availableTimeSlots: string[]
  selectedTime: string | null
  onTimeSelect: (time: string) => void
  formatTime: (time: string) => string
  userTimezone?: string
  onTimezoneChange?: (timezone: string) => void
}

export function TimeWheelPicker({
  availableTimeSlots,
  selectedTime,
  onTimeSelect,
  formatTime,
  userTimezone = "America/New_York",
  onTimezoneChange,
}: TimeWheelPickerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [startY, setStartY] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const itemHeight = 60
  const paddingTop = 130

  // Enhanced inertia system with slightly reduced momentum
  const [velocity, setVelocity] = useState(0)
  const [lastMoveTime, setLastMoveTime] = useState(0)
  const [lastMoveY, setLastMoveY] = useState(0)
  const [velocityHistory, setVelocityHistory] = useState<number[]>([])
  const animationRef = useRef<number>()

  // Added: Vibration helper function
  const triggerVibration = () => {
    // Check if vibration API is supported
    if ("vibrate" in navigator) {
      // Short, subtle vibration (20ms)
      navigator.vibrate(20)
    }
  }

  // Initialize scroll position based on selected time
  useEffect(() => {
    if (selectedTime && availableTimeSlots.length > 0) {
      const index = availableTimeSlots.findIndex((time) => time === selectedTime)
      if (index !== -1) {
        setCurrentIndex(index)
        if (containerRef.current) {
          containerRef.current.scrollTop = index * itemHeight
        }
      }
    }
  }, [selectedTime, availableTimeSlots])

  // Enhanced inertia animation with slightly more friction to stop sooner
  const animateInertia = () => {
    if (!containerRef.current || Math.abs(velocity) < 0.03) {
      // Slightly increased threshold for earlier stopping
      setVelocity(0)
      handleScroll()
      return
    }

    const newScrollTop = containerRef.current.scrollTop + velocity
    const maxScroll = (availableTimeSlots.length - 1) * itemHeight

    if (newScrollTop < 0 || newScrollTop > maxScroll) {
      setVelocity(velocity * -0.3)
      if (Math.abs(velocity) < 0.1) {
        setVelocity(0)
        handleScroll()
        return
      }
    } else {
      containerRef.current.scrollTop = newScrollTop
    }

    // Adjusted friction for slightly less momentum - more friction to stop sooner
    let friction = 0.94 // Reduced base friction for shorter coasting
    if (Math.abs(velocity) > 12) {
      friction = 0.96 // Reduced from 0.98 for high speeds
    } else if (Math.abs(velocity) > 6) {
      friction = 0.95 // Reduced from 0.97 for medium-high speeds
    } else if (Math.abs(velocity) > 2) {
      friction = 0.94 // Same for medium speeds
    } else {
      friction = 0.92 // More friction for low speeds
    }

    setVelocity(velocity * friction)
    animationRef.current = requestAnimationFrame(animateInertia)
  }

  // Handle scroll to snap to items and update selection
  const handleScroll = () => {
    if (!containerRef.current) return

    const scrollTop = containerRef.current.scrollTop
    const index = Math.round(scrollTop / itemHeight)
    const clampedIndex = Math.max(0, Math.min(index, availableTimeSlots.length - 1))

    // Added: Trigger vibration when index changes
    if (clampedIndex !== currentIndex) {
      triggerVibration()
    }

    setCurrentIndex(clampedIndex)

    if (!isDragging) {
      const targetScrollTop = clampedIndex * itemHeight
      if (Math.abs(scrollTop - targetScrollTop) > 5) {
        containerRef.current.scrollTo({
          top: targetScrollTop,
          behavior: "smooth",
        })
      }
    }
  }

  const handleStart = (clientY: number) => {
    setIsDragging(true)
    setStartY(clientY)
    setScrollTop(containerRef.current?.scrollTop || 0)
    setLastMoveTime(Date.now())
    setLastMoveY(clientY)
    setVelocity(0)
    setVelocityHistory([])

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
    }

    document.body.style.overflow = "hidden"
  }

  const handleMove = (clientY: number) => {
    if (!isDragging || !containerRef.current) return

    const now = Date.now()
    const deltaY = startY - clientY
    const newScrollTop = scrollTop + deltaY

    // Slightly reduced velocity calculation for less momentum
    const timeDelta = now - lastMoveTime
    if (timeDelta > 0) {
      const moveDelta = lastMoveY - clientY
      // Reduced velocity multiplier for less momentum
      const currentVelocity = (moveDelta / timeDelta) * 10 // Reduced from 12 to 10

      const newHistory = [...velocityHistory, currentVelocity].slice(-3)
      setVelocityHistory(newHistory)

      const avgVelocity = newHistory.reduce((sum, v) => sum + v, 0) / newHistory.length
      setVelocity(avgVelocity)
    }

    setLastMoveTime(now)
    setLastMoveY(clientY)

    containerRef.current.scrollTop = Math.max(0, Math.min(newScrollTop, (availableTimeSlots.length - 1) * itemHeight))

    // Update currentIndex during drag with vibration feedback
    const currentScrollIndex = Math.round(containerRef.current.scrollTop / itemHeight)
    const clampedCurrentIndex = Math.max(0, Math.min(currentScrollIndex, availableTimeSlots.length - 1))

    // Added: Trigger vibration when index changes during drag
    if (clampedCurrentIndex !== currentIndex) {
      triggerVibration()
    }

    setCurrentIndex(clampedCurrentIndex)
  }

  const handleEnd = () => {
    setIsDragging(false)
    document.body.style.overflow = ""

    const avgVelocity =
      velocityHistory.length > 0 ? velocityHistory.reduce((sum, v) => sum + v, 0) / velocityHistory.length : velocity

    // Slightly increased threshold for less responsive inertia
    if (Math.abs(avgVelocity) > 0.4) {
      // Increased from 0.3 to 0.4
      setVelocity(avgVelocity)
      animateInertia()
    } else {
      setTimeout(handleScroll, 50)
    }
  }

  // Mouse events
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    handleStart(e.clientY)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    e.preventDefault()
    handleMove(e.clientY)
  }

  const handleMouseUp = () => {
    handleEnd()
  }

  // Touch events
  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault()
    handleStart(e.touches[0].clientY)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault()
    handleMove(e.touches[0].clientY)
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault()
    handleEnd()
  }

  // Global mouse events when dragging
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseMove = (e: MouseEvent) => {
        e.preventDefault()
        handleMove(e.clientY)
      }
      const handleGlobalMouseUp = () => handleEnd()

      document.addEventListener("mousemove", handleGlobalMouseMove, { passive: false })
      document.addEventListener("mouseup", handleGlobalMouseUp)

      return () => {
        document.removeEventListener("mousemove", handleGlobalMouseMove)
        document.removeEventListener("mouseup", handleGlobalMouseUp)
      }
    }
  }, [isDragging, startY, scrollTop, velocity, lastMoveTime, lastMoveY])

  // Cleanup
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
      document.body.style.overflow = ""
    }
  }, [])

  if (availableTimeSlots.length === 0) return null

  const getCurrentlySelectedTime = () => {
    return availableTimeSlots[currentIndex] || availableTimeSlots[0]
  }

  const handleContinue = async () => {
    if (isProcessing) return

    setIsProcessing(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      onTimeSelect(getCurrentlySelectedTime())
    } finally {
      setTimeout(() => setIsProcessing(false), 500)
    }
  }

  return (
    <div className="relative w-full">
      {onTimezoneChange && (
        <div className="flex justify-end mb-3">
          <TimezonePicker value={userTimezone} onChange={onTimezoneChange} compact={true} />
        </div>
      )}

      <div className="relative">
        {/* Gradient overlays */}
        <div className="absolute top-0 inset-x-0 h-24 bg-gradient-to-b from-background via-background/80 to-transparent pointer-events-none z-10"></div>
        <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-background via-background/80 to-transparent pointer-events-none z-10"></div>

        <div
          ref={containerRef}
          className="h-[320px] overflow-y-scroll overflow-x-hidden scrollbar-hide relative touch-none"
          style={{
            paddingTop: `${paddingTop}px`,
            paddingBottom: `${paddingTop}px`,
          }}
          onScroll={handleScroll}
          onMouseDown={handleMouseDown}
          onMouseMove={isDragging ? handleMouseMove : undefined}
          onMouseUp={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {availableTimeSlots.map((time, index) => (
            <div
              key={time}
              className={cn(
                "relative flex items-center justify-center h-[60px] text-lg font-bold transition-all duration-200 cursor-pointer select-none",
                index === currentIndex
                  ? "text-primary scale-110 font-black"
                  : "text-muted-foreground scale-90 opacity-60",
              )}
              onClick={() => {
                // Added: Trigger vibration on click selection
                if (index !== currentIndex) {
                  triggerVibration()
                }
                setCurrentIndex(index)
                if (containerRef.current) {
                  containerRef.current.scrollTo({
                    top: index * itemHeight,
                    behavior: "smooth",
                  })
                }
              }}
            >
              {/* Selection indicator */}
              {index === currentIndex && (
                <div className="absolute inset-0 bg-primary/10 border-2 border-primary flex items-center justify-center rounded-lg">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full shadow-sm"></div>
                </div>
              )}
              <span className="relative z-10">{formatTime(time)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Continue button */}
      <div className="mt-4 text-center relative z-20">
        <button
          onClick={handleContinue}
          disabled={isProcessing}
          className="w-full bg-primary text-primary-foreground font-bold py-3 px-6 border-2 border-black transition-all duration-200 hover:scale-105 active:translate-x-[2px] active:translate-y-[2px] shadow disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:active:translate-x-0 disabled:active:translate-y-0"
        >
          {isProcessing ? (
            <div className="flex items-center justify-center">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing...
            </div>
          ) : (
            `Continue with ${formatTime(getCurrentlySelectedTime())}`
          )}
        </button>
      </div>
    </div>
  )
}
