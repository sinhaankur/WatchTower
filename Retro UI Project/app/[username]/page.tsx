import { notFound } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { cookies } from "next/headers"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Clock, Calendar, ArrowRight } from "lucide-react"
import Link from "next/link"
import { Suspense } from "react"

// Loading component
function UserPageSkeleton() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-center space-y-4 mb-8">
          <div className="w-24 h-24 bg-muted rounded-full mx-auto animate-pulse"></div>
          <div className="h-8 bg-muted rounded w-48 mx-auto animate-pulse"></div>
          <div className="h-4 bg-muted rounded w-64 mx-auto animate-pulse"></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-48 bg-muted rounded-lg animate-pulse"></div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Get user and their public event types
async function getUserWithEventTypes(username: string) {
  const cookieStore = cookies()
  const supabase = createClient(cookieStore)

  // Get user profile
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, username, full_name, avatar_url, email")
    .eq("username", username)
    .single()

  if (userError || !user) {
    return null
  }

  // Get their active event types
  const { data: eventTypes, error: eventTypesError } = await supabase
    .from("event_types")
    .select("id, title, slug, duration, description")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (eventTypesError) {
    console.error("Error fetching event types:", eventTypesError)
    return { user, eventTypes: [] }
  }

  return { user, eventTypes: eventTypes || [] }
}

export default async function UserPublicPage({ params }: { params: { username: string } }) {
  const data = await getUserWithEventTypes(params.username)

  if (!data) {
    notFound()
  }

  const { user, eventTypes } = data

  return (
    <Suspense fallback={<UserPageSkeleton />}>
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
          {/* Simplified User Profile Header */}
          <div className="text-center space-y-6 mb-12">
            <div className="space-y-4">
              {/* Simplified header - everything in one clean line */}
              <div className="flex items-center justify-center space-x-4">
                <Avatar className="w-16 h-16 border-4 shadow-lg">
                  <AvatarImage src={user.avatar_url || "/placeholder.svg"} alt={user.full_name} />
                  <AvatarFallback className="text-2xl font-bold bg-primary/10 text-primary">
                    {user.full_name?.charAt(0) || user.username?.charAt(0) || "U"}
                  </AvatarFallback>
                </Avatar>

                <div className="text-left">
                  <h1 className="text-2xl sm:text-3xl font-bold">{user.full_name || user.username}</h1>
                  <div className="flex items-center space-x-2 text-muted-foreground">
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-sm">Available for booking</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Event Types Grid */}
          {eventTypes.length === 0 ? (
            <Card className="shadow-md">
              <CardContent className="py-12 px-6">
                <div className="text-center space-y-4 max-w-md mx-auto">
                  <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto border-2">
                    <Calendar className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-bold">No events available</h3>
                    <p className="text-muted-foreground">
                      {user.full_name || user.username} hasn't set up any bookable events yet.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl sm:text-2xl font-bold mb-2">Available Events</h2>
                <p className="text-muted-foreground">Choose an event type below to schedule your meeting</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {eventTypes.map((eventType) => (
                  <Card
                    key={eventType.id}
                    className="group hover:shadow-lg transition-all duration-200 cursor-pointer border-2 hover:border-primary/20"
                  >
                    <CardHeader className="pb-4">
                      <div className="space-y-3">
                        <CardTitle className="text-lg font-bold group-hover:text-primary transition-colors">
                          {eventType.title}
                        </CardTitle>

                        <div className="flex items-center text-muted-foreground">
                          <Clock className="mr-2 h-4 w-4" />
                          <span className="text-sm font-medium">{eventType.duration} minutes</span>
                        </div>

                        {eventType.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2">{eventType.description}</p>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="pt-0">
                      <Button asChild className="w-full group-hover:scale-105 transition-transform">
                        <Link href={`/${user.username}/${eventType.slug}`}>
                          Book Now
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </Link>
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="text-center mt-16 pt-8 border-t-2">
            <p className="text-sm text-muted-foreground">
              Powered by <span className="font-bold">v0 Calendar</span>
            </p>
          </div>
        </div>
      </div>
    </Suspense>
  )
}

// Generate metadata for better SEO
export async function generateMetadata({ params }: { params: { username: string } }) {
  const data = await getUserWithEventTypes(params.username)

  if (!data) {
    return {
      title: "User Not Found",
      description: "The requested user profile could not be found.",
    }
  }

  const { user, eventTypes } = data
  const userName = user.full_name || user.username

  return {
    title: `Book with ${userName} - v0 Calendar`,
    description: `Schedule a meeting with ${userName}. ${eventTypes.length} event type${eventTypes.length !== 1 ? "s" : ""} available for booking.`,
    openGraph: {
      title: `Book with ${userName}`,
      description: `Schedule a meeting with ${userName}. Choose from ${eventTypes.length} available event types.`,
      type: "website",
    },
  }
}
