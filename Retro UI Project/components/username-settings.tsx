"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Check, X, Edit2, User, ExternalLink, Globe, Copy } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"

interface UsernameSettingsProps {
  currentUsername: string
  baseUrl: string
}

export function UsernameSettings({ currentUsername, baseUrl }: UsernameSettingsProps) {
  const [username, setUsername] = useState(currentUsername)
  const [isEditing, setIsEditing] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  // Added CSRF token state
  const [csrfToken, setCsrfToken] = useState<string>("")
  const { toast } = useToast()

  // Get CSRF token on component mount
  useEffect(() => {
    const fetchCsrfToken = async () => {
      try {
        const response = await fetch("/api/csrf-token")
        const data = await response.json()
        setCsrfToken(data.token)
      } catch (error) {
        console.error("Error fetching CSRF token:", error)
      }
    }
    fetchCsrfToken()
  }, [])

  // Check username availability with debouncing
  useEffect(() => {
    if (!isEditing || username === currentUsername || username.length < 3 || !csrfToken) {
      setIsAvailable(null)
      return
    }

    const timeoutId = setTimeout(async () => {
      setIsChecking(true)
      try {
        const response = await fetch("/api/check-username", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Added CSRF token header
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ username }),
        })
        const data = await response.json()
        setIsAvailable(data.available)
      } catch (error) {
        console.error("Error checking username:", error)
        setIsAvailable(null)
      } finally {
        setIsChecking(false)
      }
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [username, currentUsername, isEditing, csrfToken]) // Added csrfToken dependency

  const handleSave = async () => {
    if (!isAvailable || username === currentUsername || !csrfToken) return

    setIsSaving(true)
    try {
      const response = await fetch("/api/update-username", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Added CSRF token header
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ username }),
      })

      if (response.ok) {
        toast({
          title: "Username updated",
          description: "Your username has been successfully updated.",
        })
        setIsEditing(false)
        window.location.reload()
      } else {
        const data = await response.json()

        // Enhanced error handling for rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After")
          toast({
            title: "Too many requests",
            description: `Please wait ${retryAfter || "60"} seconds before trying again.`,
            variant: "destructive",
          })
        } else {
          toast({
            title: "Error",
            description: data.error || "Failed to update username",
            variant: "destructive",
          })
        }
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update username",
        variant: "destructive",
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setUsername(currentUsername)
    setIsEditing(false)
    setIsAvailable(null)
  }

  const cleanUsername = (value: string) => {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  }

  const fullUrl = `${baseUrl.replace(/^https?:\/\//, "")}/${currentUsername}`

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(`https://${fullUrl}`)
      setCopied(true)
      toast({
        title: "URL copied!",
        description: "Your booking URL has been copied to clipboard.",
      })
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      toast({
        title: "Failed to copy",
        description: "Could not copy URL to clipboard.",
        variant: "destructive",
      })
    }
  }

  return (
    // Fixed: Added min-height to prevent layout shifts
    <Card className="group hover:shadow-md transition-all duration-200 border-2 min-h-[280px] flex flex-col">
      <CardHeader className="pb-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-blue-50 border-2 border-blue-100 flex items-center justify-center group-hover:bg-blue-100 transition-colors">
            <User className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base font-bold flex items-center space-x-2">
              <span>Booking URL</span>
              <Badge variant="secondary" className="text-xs">
                <Globe className="h-3 w-3 mr-1" />
                Public
              </Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Your personalized booking link</p>
          </div>
        </div>
      </CardHeader>

      {/* Fixed: Added flex-1 to make content area expand and maintain consistent height */}
      <CardContent className="space-y-4 flex-1 flex flex-col">
        {isEditing ? (
          // Fixed: Added flex-1 to editing content to maintain height
          <div className="space-y-4 flex-1 flex flex-col justify-between">
            {/* Enhanced URL builder */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Preview URL</label>
              <div className="flex items-center space-x-1 p-3 bg-muted/50 border-2 border-dashed">
                <span className="text-sm text-muted-foreground">{baseUrl.replace(/^https?:\/\//, "")}/</span>
                <div className="relative">
                  <Input
                    value={username}
                    onChange={(e) => setUsername(cleanUsername(e.target.value))}
                    className="w-32 h-8 text-sm font-mono border-primary/50 focus:border-primary"
                    placeholder="username"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2">
                    {isChecking && <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary"></div>}
                    {!isChecking && isAvailable === true && <Check className="h-3 w-3 text-green-500" />}
                    {!isChecking && isAvailable === false && <X className="h-3 w-3 text-red-500" />}
                  </div>
                </div>
              </div>
              {/* Fixed: Consistent height for validation messages */}
              <div className="min-h-[20px]">
                {isAvailable === false && (
                  <p className="text-xs text-red-600 flex items-center space-x-1">
                    <X className="h-3 w-3" />
                    <span>Username is already taken</span>
                  </p>
                )}
                {isAvailable === true && (
                  <p className="text-xs text-green-600 flex items-center space-x-1">
                    <Check className="h-3 w-3" />
                    <span>Username is available</span>
                  </p>
                )}
              </div>
            </div>

            {/* Enhanced action buttons - positioned at bottom */}
            <div className="flex items-center space-x-2 pt-2 mt-auto">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!isAvailable || isSaving || username === currentUsername}
                className="flex-1"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleCancel} className="bg-transparent">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          // Fixed: Added flex-1 to non-editing content to maintain height
          <div className="space-y-4 flex-1 flex flex-col justify-between">
            {/* Enhanced URL display */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Your URL</label>
              <div className="flex items-center space-x-2 p-3 bg-gray-50 border-2 group-hover:bg-gray-100 transition-colors">
                <div className="flex-1 font-mono text-sm text-gray-700 truncate">{fullUrl}</div>
                <div className="flex items-center space-x-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyUrl}
                    className={cn(
                      "h-7 w-7 p-0 transition-colors",
                      copied ? "text-green-600" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(`https://${fullUrl}`, "_blank")}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Fixed: Button positioned at bottom with mt-auto */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsEditing(true)}
              className="w-full bg-transparent hover:bg-accent hover:text-accent-foreground transition-all mt-auto"
            >
              <Edit2 className="h-3 w-3 mr-2" />
              Edit Username
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
