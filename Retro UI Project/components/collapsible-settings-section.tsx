"use client"

import { Button } from "@/components/ui/button"
import { Settings, ChevronDown } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useMobile } from "@/hooks/use-mobile"
import { useState } from "react"
import { GoogleCalendarStatus } from "@/components/google-calendar-status"
import { UsernameSettings } from "@/components/username-settings"

interface CollapsibleSettingsSectionProps {
  isGoogleConnected: boolean
  userEmail?: string
  currentUsername: string
  baseUrl: string
}

export function CollapsibleSettingsSection({
  isGoogleConnected,
  userEmail,
  currentUsername,
  baseUrl,
}: CollapsibleSettingsSectionProps) {
  const [isOpen, setIsOpen] = useState(false)
  const isMobile = useMobile()

  // On desktop, always show settings (no collapsible behavior)
  if (!isMobile) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg sm:text-xl md:text-2xl font-bold">Account Settings</h2>
          <p className="text-muted-foreground text-sm mt-1">Manage your profile and integrations</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
          <UsernameSettings currentUsername={currentUsername} baseUrl={baseUrl} />
          <GoogleCalendarStatus isConnected={isGoogleConnected} userEmail={userEmail} />
        </div>
      </div>
    )
  }

  // On mobile, use collapsible behavior
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg sm:text-xl md:text-2xl font-bold">Account Settings</h2>
          <p className="text-muted-foreground text-sm mt-1">Manage your profile and integrations</p>
        </div>

        {/* Mobile toggle button */}
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="bg-transparent">
            <Settings className="h-4 w-4 mr-2" />
            <span className="text-sm">{isOpen ? "Hide" : "Show"}</span>
            <ChevronDown className={`h-4 w-4 ml-2 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} />
          </Button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4">
          <UsernameSettings currentUsername={currentUsername} baseUrl={baseUrl} />
          <GoogleCalendarStatus isConnected={isGoogleConnected} userEmail={userEmail} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
