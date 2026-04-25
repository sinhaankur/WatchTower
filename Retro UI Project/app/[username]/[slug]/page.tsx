import { notFound } from "next/navigation"
import { getEventTypeBySlug } from "@/lib/actions/event-types"
import { Calendar } from "@/components/calendar"
import { Suspense } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2 } from "lucide-react"
import Link from "next/link"

// Loading component for better UX
function BookingPageSkeleton() {
  return (
    <div className="mobile-no-page-scroll min-h-screen w-full flex items-center justify-center p-0">
      <div className="w-full max-w-2xl mx-auto px-4 py-2 md:px-4 md:py-4">
        <Card className="shadow-lg border-2 w-full max-w-2xl mx-auto">
          <CardContent className="p-8 text-center">
            <Loader2 className="animate-spin h-8 w-8 text-primary mx-auto mb-4" />
            <p className="text-lg font-medium">Loading booking page...</p>
            <p className="text-sm text-muted-foreground mt-2">Please wait while we prepare your calendar</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// Server Component for better performance and SEO
export default async function EventBookingPage({ params }: { params: { username: string; slug: string } }) {
  const eventType = await getEventTypeBySlug(params.username, params.slug)

  if (!eventType) {
    notFound()
  }

  return (
    <Suspense fallback={<BookingPageSkeleton />}>
      {/* Updated mobile layout to show footer */}
      <div className="mobile-booking-layout md:mobile-no-page-scroll min-h-screen w-full md:flex md:items-center md:justify-center p-0">
        {/* Updated content wrapper for mobile footer visibility */}
        <div className="mobile-booking-content md:w-full md:max-w-2xl md:mx-auto px-4 py-2 md:px-4 md:py-4">
          {/* Added: Container for calendar + footer as a single block */}
          <div className="w-full max-w-2xl mx-auto space-y-4">
            <Calendar
              eventTypeId={eventType.id}
              ownerTimezone={eventType.timezone || "America/New_York"}
              eventTitle={eventType.title}
              duration={eventType.duration}
              hostName={eventType.user_full_name || "Host"}
              hostAvatar={eventType.user_avatar_url}
              hostFullName={eventType.user_full_name}
            />

            {/* Added: Footer attached to the calendar card */}
            <footer className="border-t border-border py-4">
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <span>Vibe coded with</span>
                  <Link
                    href="https://v0.dev/community/v0-calendar-CqmWrCLIczY"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    v0 - Clone and prompt
                  </Link>
                </div>
                <span className="hidden sm:inline">•</span>
                <div className="flex items-center gap-1">
                  <span>feedback?</span>
                  <Link
                    href="https://x.com/EstebanSuarez"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    send me a dm!
                  </Link>
                </div>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </Suspense>
  )
}

// Generate metadata for better SEO
export async function generateMetadata({ params }: { params: { username: string; slug: string } }) {
  const eventType = await getEventTypeBySlug(params.username, params.slug)

  if (!eventType) {
    return {
      title: "Event Not Found",
      description: "The requested booking page could not be found.",
    }
  }

  return {
    title: `Book ${eventType.title} with ${eventType.user_full_name}`,
    description: `Schedule a ${eventType.duration}-minute ${eventType.title} session with ${eventType.user_full_name}. Pick a time that works for both of you.`,
    openGraph: {
      title: `Book ${eventType.title} with ${eventType.user_full_name}`,
      description: `Schedule a ${eventType.duration}-minute ${eventType.title} session with ${eventType.user_full_name}`,
      type: "website",
    },
  }
}
