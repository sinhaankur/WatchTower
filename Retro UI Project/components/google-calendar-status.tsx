"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CheckCircle, AlertCircle, X, Calendar, Unlink, ExternalLink } from "lucide-react"
import { connectGoogleCalendar, disconnectGoogleCalendar } from "@/lib/google-calendar"
import { useSearchParams } from "next/navigation"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"

interface GoogleCalendarStatusProps {
  isConnected?: boolean
  userEmail?: string
}

export function GoogleCalendarStatus({ isConnected = false, userEmail }: GoogleCalendarStatusProps) {
  const [isClientConnected, setIsClientConnected] = useState(isConnected)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [alertStatus, setAlertStatus] = useState<"idle" | "success" | "error" | "disconnected">("idle")
  const [errorMessage, setErrorMessage] = useState("")
  const [errorDetails, setErrorDetails] = useState("")
  const searchParams = useSearchParams()

  // Handle OAuth callback results from URL parameters
  useEffect(() => {
    const googleConnected = searchParams.get("google_connected")
    const googleError = searchParams.get("google_error")
    const errorDetailsParam = searchParams.get("error_details")

    if (googleConnected === "true") {
      setIsClientConnected(true)
      setAlertStatus("success")
      window.history.replaceState({}, "", "/")
    } else if (googleError) {
      setAlertStatus("error")
      setErrorDetails(errorDetailsParam ? decodeURIComponent(errorDetailsParam) : "")

      // Map error codes to user-friendly messages
      switch (googleError) {
        case "access_denied":
          setErrorMessage("Access was denied. Please try again and grant the necessary permissions.")
          break
        case "no_code":
          setErrorMessage("No authorization code received from Google.")
          break
        case "callback_failed":
          setErrorMessage("Failed to process Google Calendar connection.")
          break
        case "api_import_error":
          setErrorMessage("Failed to load Google APIs. This might be a temporary issue.")
          break
        case "oauth_error":
          setErrorMessage("OAuth authentication failed. Please try again.")
          break
        case "token_error":
          setErrorMessage("Failed to get access tokens from Google.")
          break
        case "database_error":
          setErrorMessage("Failed to save connection to database. Please try again.")
          break
        case "auth_error":
          setErrorMessage("You need to be logged in to connect Google Calendar.")
          break
        default:
          setErrorMessage(`Connection failed: ${googleError}`)
      }
      window.history.replaceState({}, "", "/")
    }
  }, [searchParams])

  const handleConnect = async () => {
    setConnecting(true)
    setAlertStatus("idle")
    try {
      const authUrl = await connectGoogleCalendar()
      if (process.env.NODE_ENV === "development") {
        setIsClientConnected(true)
        setAlertStatus("success")
      } else {
        console.log("🔗 Redirecting to Google OAuth:", authUrl)
        window.location.href = authUrl
      }
    } catch (error) {
      console.error("Error connecting to Google Calendar:", error)
      setAlertStatus("error")
      setErrorMessage("Failed to initiate Google Calendar connection.")
      setErrorDetails(error instanceof Error ? error.message : "Unknown error")
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      const result = await disconnectGoogleCalendar()
      if (result.success) {
        setIsClientConnected(false)
        setAlertStatus("disconnected")
      } else {
        setAlertStatus("error")
        setErrorMessage(result.error || "Failed to disconnect Google Calendar")
      }
    } catch (error) {
      console.error("Error disconnecting Google Calendar:", error)
      setAlertStatus("error")
      setErrorMessage("Failed to disconnect Google Calendar.")
    } finally {
      setDisconnecting(false)
    }
  }

  const dismissAlert = () => {
    setAlertStatus("idle")
    setErrorMessage("")
    setErrorDetails("")
  }

  const AlertBox = ({
    variant,
    icon,
    title,
    message,
  }: {
    variant: "success" | "destructive" | "warning"
    icon: React.ReactNode
    title: string
    message: string
  }) => (
    // Fixed: Changed positioning to fixed at top of viewport instead of absolute relative to card
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4">
      <Alert
        variant={variant === "success" ? "default" : variant}
        className={cn(
          "border-2 shadow-lg",
          variant === "success" && "border-accent bg-white text-foreground",
          variant === "warning" && "border-secondary bg-white text-foreground",
        )}
      >
        <div className="flex">
          <div className="mr-3 flex-shrink-0">{icon}</div>
          <div className="flex-grow">
            <AlertTitle className="font-bold text-foreground">{title}</AlertTitle>
            <AlertDescription className="text-foreground">{message}</AlertDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={dismissAlert} className="ml-4 h-6 w-6 flex-shrink-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </Alert>
    </div>
  )

  return (
    // Fixed: Removed relative positioning and added consistent min-height
    <div className="min-h-[280px]">
      {/* Status alerts - now positioned fixed at top of screen */}
      {alertStatus === "success" && (
        <AlertBox
          variant="success"
          icon={<CheckCircle className="h-5 w-5 text-accent" />}
          title="Success!"
          message="Google Calendar connected. Bookings will now be synced."
        />
      )}
      {alertStatus === "disconnected" && (
        <AlertBox
          variant="warning"
          icon={<AlertCircle className="h-5 w-5 text-secondary" />}
          title="Disconnected"
          message="Google Calendar has been disconnected."
        />
      )}
      {alertStatus === "error" && (
        <AlertBox
          variant="destructive"
          icon={<AlertCircle className="h-5 w-5" />}
          title="Connection Failed"
          message={errorMessage}
        />
      )}

      {/* Card content - now maintains consistent positioning and height */}
      <Card className="group hover:shadow-md transition-all duration-200 border-2 h-full flex flex-col">
        <CardHeader className="pb-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-green-50 border-2 border-green-100 flex items-center justify-center group-hover:bg-green-100 transition-colors">
              <Calendar className="h-5 w-5 text-green-600" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-base font-bold flex items-center space-x-2">
                <span>Google Calendar</span>
                {/* Simple status badge matching the URL's "Public" badge style */}
                <Badge variant="secondary" className="text-xs">
                  {isClientConnected ? (
                    <>
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Connected
                    </>
                  ) : (
                    <>
                      <Calendar className="h-3 w-3 mr-1" />
                      Integration
                    </>
                  )}
                </Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {isClientConnected ? "Bookings sync automatically" : "Connect to sync your calendar"}
              </p>
            </div>
          </div>
        </CardHeader>

        {/* Fixed: Added flex-1 to make content area expand and maintain consistent height */}
        <CardContent className="space-y-4 flex-1 flex flex-col">
          {isClientConnected ? (
            // Fixed: Added flex-1 and justify-between to maintain consistent spacing
            <div className="space-y-4 flex-1 flex flex-col justify-between">
              {/* Connected account display - matching URL display style */}
              {userEmail && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Connected Account</label>
                  <div className="flex items-center space-x-2 p-3 bg-gray-50 border-2 group-hover:bg-gray-100 transition-colors">
                    <div className="flex-1 font-mono text-sm text-gray-700 truncate">{userEmail}</div>
                    <div className="flex items-center space-x-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.open("https://calendar.google.com", "_blank")}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Disconnect button - positioned at bottom with mt-auto */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disconnecting}
                    className="w-full bg-transparent hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50 transition-all mt-auto"
                  >
                    <Unlink className="h-3 w-3 mr-2" />
                    {disconnecting ? "Disconnecting..." : "Disconnect Calendar"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
                    <AlertDialogDescription className="space-y-2">
                      <p>Are you sure you want to disconnect your Google Calendar?</p>
                      <p className="text-sm text-muted-foreground">
                        • New bookings will no longer be automatically added to your calendar
                        <br />• Existing calendar events will not be affected
                        <br />• You can reconnect at any time
                      </p>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDisconnect}
                      className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : (
            // Fixed: Added flex-1 and justify-between for consistent spacing
            <div className="space-y-4 flex-1 flex flex-col justify-between">
              {/* Not connected state - simple and clean */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Status</label>
                <div className="p-3 bg-gray-50 border-2 group-hover:bg-gray-100 transition-colors">
                  <div className="text-sm text-gray-700">Not connected</div>
                </div>
              </div>

              {/* Connect button - positioned at bottom with mt-auto */}
              <Button
                onClick={handleConnect}
                disabled={connecting}
                size="sm"
                className="w-full bg-transparent hover:bg-accent hover:text-accent-foreground transition-all mt-auto"
                variant="outline"
              >
                <Calendar className="h-3 w-3 mr-2" />
                {connecting ? "Connecting..." : "Connect Google Calendar"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
