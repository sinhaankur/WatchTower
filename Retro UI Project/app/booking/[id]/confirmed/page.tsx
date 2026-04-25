import { notFound } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { CheckCircle, Calendar, Clock, User, Mail, MessageSquare, ArrowLeft, Plus } from "lucide-react"
import Link from "next/link"
import { getBookingById } from "@/lib/actions/bookings"
// Added: Import for user authentication
import { getUser } from "@/lib/auth/get-user"

// Added: Security function to verify booking access
async function verifyBookingAccess(bookingId: string, searchParams: URLSearchParams) {
  const booking = await getBookingById(bookingId)
  if (!booking) return null

  // Check if user is the host (authenticated user)
  const user = await getUser()
  if (user && user.id === booking.event_type.user.id) {
    console.log(`✅ [BOOKING_AUTH] Host access granted for booking ${bookingId}`)
    return booking
  }

  // Check if guest is accessing with their email token
  const guestToken = searchParams.get("token")
  const guestEmail = searchParams.get("email")

  if (guestToken && guestEmail) {
    // Simple token verification: hash of booking ID + guest email
    const expectedToken = Buffer.from(`${bookingId}:${booking.guest_email}`).toString("base64")

    if (guestToken === expectedToken && guestEmail.toLowerCase() === booking.guest_email.toLowerCase()) {
      console.log(`✅ [BOOKING_AUTH] Guest access granted for booking ${bookingId}`)
      return booking
    }
  }

  console.log(`❌ [BOOKING_AUTH] Access denied for booking ${bookingId}`)
  return null
}

export default async function BookingConfirmedPage({
  params,
  searchParams,
}: {
  params: { id: string }
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  // Convert searchParams to URLSearchParams for easier handling
  const urlSearchParams = new URLSearchParams()
  Object.entries(searchParams).forEach(([key, value]) => {
    if (typeof value === "string") {
      urlSearchParams.set(key, value)
    }
  })

  // Added: Verify access before showing booking details
  const booking = await verifyBookingAccess(params.id, urlSearchParams)

  if (!booking) {
    // Added: Redirect to a generic "not found" instead of exposing that booking exists
    notFound()
  }

  // Fixed: Use the guest's timezone that was used during booking
  const startDate = new Date(booking.start_time)
  const endDate = new Date(booking.end_time)

  // Use the timezone that was stored when the booking was made
  const displayTimezone = booking.guest_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: displayTimezone, // Use the guest's original timezone
    })
  }

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: displayTimezone, // Use the guest's original timezone
    })
  }

  return (
    // Changed: Now the layout handles centering, so we just need the content container
    <div className="w-full max-w-2xl space-y-6">
      {/* Success Header */}
      <div className="text-center space-y-4">
        <div className="w-20 h-20 bg-accent border-2 rounded-full flex items-center justify-center mx-auto shadow-lg">
          <CheckCircle className="w-12 h-12 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-4xl font-bold text-foreground">Booking Confirmed!</h1>
          <p className="text-muted-foreground mt-2 text-lg">
            Your meeting is scheduled. A confirmation email is on its way.
          </p>
        </div>
      </div>

      {/* Booking Details Card */}
      <Card className="shadow-md border-2">
        <CardHeader>
          <CardTitle className="flex items-center text-xl font-bold">
            <Calendar className="h-5 w-5 mr-3" />
            {booking.event_type.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <div className="flex items-start space-x-3">
              <Calendar className="h-5 w-5 text-muted-foreground mt-1" />
              <div>
                <p className="text-sm text-muted-foreground">Date</p>
                <p className="font-bold">{formatDate(startDate)}</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Clock className="h-5 w-5 text-muted-foreground mt-1" />
              <div>
                <p className="text-sm text-muted-foreground">Time</p>
                <p className="font-bold">
                  {formatTime(startDate)} - {formatTime(endDate)}
                </p>
                <p className="text-xs text-muted-foreground">
                  ({booking.event_type.duration} minutes) • {displayTimezone}
                </p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <User className="h-5 w-5 text-muted-foreground mt-1" />
              <div>
                <p className="text-sm text-muted-foreground">Host</p>
                <p className="font-bold">{booking.event_type.user.full_name}</p>
              </div>
            </div>

            <div className="flex items-start space-x-3">
              <Mail className="h-5 w-5 text-muted-foreground mt-1" />
              <div>
                <p className="text-sm text-muted-foreground">Guest</p>
                <p className="font-bold">{booking.guest_name}</p>
                <p className="text-xs text-muted-foreground">{booking.guest_email}</p>
              </div>
            </div>
          </div>

          {booking.notes && (
            <div className="border-t-2 pt-4">
              <div className="flex items-start space-x-3">
                <MessageSquare className="h-5 w-5 text-muted-foreground mt-1 flex-shrink-0" />
                <div>
                  <p className="text-sm text-muted-foreground">Additional Notes</p>
                  <p className="text-base mt-1 whitespace-pre-wrap">{booking.notes}</p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Action Buttons Card */}
      <Card className="shadow-md border-2">
        <CardContent className="p-6">
          <div className="space-y-4">
            <div className="text-center">
              <h3 className="text-lg font-bold mb-2">What's next?</h3>
              <p className="text-muted-foreground text-sm">
                Need another meeting or want to create your own booking page?
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <Button variant="outline" asChild className="flex-1 bg-transparent">
                <Link href={`/${booking.event_type.user.username}/${booking.event_type.slug}`}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Book Another Meeting
                </Link>
              </Button>
              <Button asChild className="flex-1">
                <Link href="/">
                  <Plus className="h-4 w-4 mr-2" />
                  Create Your Own Events
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="text-center">
        <p className="text-xs text-muted-foreground font-mono">Booking Ref: {booking.id}</p>
      </div>

      {/* Added: Footer as part of the content, attached to the card */}
      <footer className="border-t border-border py-4 mt-4">
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
  )
}
