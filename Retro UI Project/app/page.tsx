import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Plus, Clock, Edit } from "lucide-react"
import Link from "next/link"
import { getEventTypes } from "@/lib/actions/event-types"
import { getUser } from "@/lib/auth/get-user"
import { getBaseUrl } from "@/lib/utils/url"
import { LoginForm } from "@/components/login-form"
import { DeleteEventTypeButton } from "@/components/delete-event-type-button"
import { CopyLinkButton } from "@/components/copy-link-button"
// Added import for the new collapsible settings component
import { CollapsibleSettingsSection } from "@/components/collapsible-settings-section"

// Fixed: Removed "use client" directive - this needs to be a Server Component
// to use getUser() and getEventTypes() which depend on cookies()
export default async function DashboardPage() {
  const user = await getUser()

  if (!user) {
    return <LoginForm />
  }

  const eventTypes = await getEventTypes()
  const baseUrl = getBaseUrl()
  const isGoogleConnected = !!user.google_access_token

  return (
    <div className="max-w-5xl mx-auto space-y-6 px-4 sm:px-6">
      {/* Header Section - Fixed alignment issues */}
      <div className="space-y-4">
        {/* Changed from flex with items-end to grid for better alignment control */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 lg:gap-8 items-start">
          <div className="space-y-2">
            {/* Changed from "Event Types" to "Dashboard" to be less confusing */}
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground text-sm sm:text-base md:text-lg">
              Manage your account settings and bookable events.
            </p>
          </div>
          {/* Button now properly aligned with title using grid */}
          <div className="flex justify-start lg:justify-end">
            <Link href="/events/new" className="block w-full sm:w-auto">
              <Button size="default" className="shadow-lg w-full sm:w-auto h-11 text-sm sm:text-base">
                <Plus className="mr-2 h-4 w-4 sm:h-5 sm:w-5" />
                New Event Type
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Enhanced Settings Section with Mobile Collapsible - Now using separate client component */}
      <CollapsibleSettingsSection
        isGoogleConnected={isGoogleConnected}
        userEmail={user.email}
        currentUsername={user.user_name}
        baseUrl={baseUrl}
      />

      {/* Event Types Section */}
      <div className="space-y-4">
        {/* Fixed: Proper flex layout to align title and count on same line */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg sm:text-xl md:text-2xl font-bold leading-tight">Event Types</h2>
            <p className="text-muted-foreground text-sm mt-1">Create and manage your bookable events</p>
          </div>
          {/* Moved event count to be inline with title */}
          {eventTypes.length > 0 && (
            <span className="text-xs sm:text-sm font-mono text-muted-foreground">
              {eventTypes.length} event type{eventTypes.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {eventTypes.length === 0 ? (
          <Card className="shadow-md">
            <CardContent className="py-8 sm:py-12 md:py-16 px-4 sm:px-6">
              <div className="text-center space-y-4 sm:space-y-6 max-w-md mx-auto">
                <div className="w-12 sm:w-16 md:w-20 h-12 sm:h-16 md:h-20 bg-muted rounded-full flex items-center justify-center mx-auto border-2">
                  <Clock className="w-6 sm:w-8 md:w-10 h-6 sm:h-8 md:h-10 text-muted-foreground" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg sm:text-xl md:text-2xl font-bold leading-tight">No event types yet</h3>
                  <p className="text-muted-foreground text-sm sm:text-base">
                    Create your first event type to start accepting bookings.
                  </p>
                </div>
                <div className="mt-4 sm:mt-6 md:mt-8">
                  <Link href="/events/new">
                    <Button size="default" className="shadow-lg w-full sm:w-auto h-11">
                      <Plus className="mr-2 h-4 w-4" />
                      Create Event Type
                    </Button>
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4 sm:space-y-6">
            {/* Enhanced mobile grid with better card sizing */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-4 md:gap-6 lg:gap-8">
              {eventTypes.map((event) => (
                <Card
                  key={event.id}
                  className="bg-card hover:shadow-lg transition-shadow duration-200 flex flex-col min-h-[200px]"
                >
                  {/* Increased mobile padding for better card size */}
                  <CardHeader className="pb-4 sm:pb-4 flex-grow px-4 sm:px-4 md:px-6 pt-4 sm:pt-4 md:pt-6">
                    <div className="space-y-3">
                      <CardTitle className="text-lg sm:text-lg md:text-xl font-bold leading-tight">
                        {event.title}
                      </CardTitle>
                      <div className="flex items-center text-muted-foreground">
                        <Clock className="mr-2 h-4 w-4 sm:h-4 sm:w-4" />
                        <span className="text-sm sm:text-sm font-mono">{event.duration} minutes</span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-4 sm:space-y-4 px-4 sm:px-4 md:px-6 pb-4 sm:pb-4 md:pb-6">
                    {/* Fixed: Show the END of the URL (unique part) instead of the beginning */}
                    <div className="bg-muted px-3 sm:px-3 py-2 sm:py-2 border-2 overflow-hidden">
                      <div className="font-mono text-xs sm:text-xs">
                        {/* Changed: Show unique part first, then truncate domain if needed */}
                        <div className="flex items-center">
                          <span className="text-muted-foreground shrink-0">...</span>
                          <span className="font-bold text-foreground">/{user.user_name}</span>
                          <span className="text-muted-foreground">/</span>
                          <span className="font-bold text-foreground">{event.slug}</span>
                        </div>
                      </div>
                    </div>

                    {/* Significantly enhanced button layout for mobile with better copy button */}
                    <div className="flex flex-col space-y-3 sm:space-y-0 sm:flex-row sm:items-center sm:justify-between sm:space-x-2 pt-2 sm:pt-2">
                      <CopyLinkButton
                        variant="secondary"
                        size="default"
                        link={`${baseUrl}/${user.user_name}/${event.slug}`}
                        className="flex-1 text-sm sm:text-sm h-10 sm:h-9 font-bold"
                      />
                      <div className="flex items-center justify-center space-x-2">
                        <Button variant="ghost" size="sm" asChild className="h-10 w-10 sm:h-9 sm:w-9 p-0">
                          <Link href={`/events/${event.slug}/edit`}>
                            <Edit className="h-4 w-4 sm:h-4 sm:w-4" />
                          </Link>
                        </Button>
                        <DeleteEventTypeButton eventTypeId={event.id} eventTypeName={event.title} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
