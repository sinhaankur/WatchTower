import { type NextRequest, NextResponse } from "next/server"
import { getTimezoneFromCountry } from "@/lib/utils/timezone"

export async function GET(request: NextRequest) {
  try {
    // Get country from Vercel headers
    const country = request.headers.get("x-vercel-ip-country")
    const city = request.headers.get("x-vercel-ip-city")
    const region = request.headers.get("x-vercel-ip-country-region")

    console.log(`🌍 [TIMEZONE-API] Vercel headers - Country: ${country}, City: ${city}, Region: ${region}`)

    let detectedTimezone = "UTC"

    if (country) {
      // Use country-based timezone mapping
      detectedTimezone = getTimezoneFromCountry(country)
      console.log(`🌍 [TIMEZONE-API] Mapped ${country} to ${detectedTimezone}`)
    }

    // Enhanced detection for US regions
    if (country === "US" && region) {
      const usTimezoneMap: Record<string, string> = {
        CA: "America/Los_Angeles",
        WA: "America/Los_Angeles",
        OR: "America/Los_Angeles",
        NV: "America/Los_Angeles",
        AZ: "America/Phoenix",
        UT: "America/Denver",
        CO: "America/Denver",
        NM: "America/Denver",
        WY: "America/Denver",
        MT: "America/Denver",
        ND: "America/Denver",
        SD: "America/Denver",
        NE: "America/Denver",
        KS: "America/Chicago",
        OK: "America/Chicago",
        TX: "America/Chicago",
        MN: "America/Chicago",
        IA: "America/Chicago",
        MO: "America/Chicago",
        AR: "America/Chicago",
        LA: "America/Chicago",
        MS: "America/Chicago",
        AL: "America/Chicago",
        TN: "America/Chicago",
        KY: "America/New_York",
        IN: "America/New_York",
        IL: "America/Chicago",
        WI: "America/Chicago",
        MI: "America/New_York",
        OH: "America/New_York",
        WV: "America/New_York",
        VA: "America/New_York",
        NC: "America/New_York",
        SC: "America/New_York",
        GA: "America/New_York",
        FL: "America/New_York",
        PA: "America/New_York",
        NY: "America/New_York",
        VT: "America/New_York",
        NH: "America/New_York",
        ME: "America/New_York",
        MA: "America/New_York",
        RI: "America/New_York",
        CT: "America/New_York",
        NJ: "America/New_York",
        DE: "America/New_York",
        MD: "America/New_York",
        DC: "America/New_York",
        HI: "Pacific/Honolulu",
        AK: "America/Anchorage",
      }

      const regionTimezone = usTimezoneMap[region.toUpperCase()]
      if (regionTimezone) {
        detectedTimezone = regionTimezone
        console.log(`🌍 [TIMEZONE-API] US region ${region} mapped to ${detectedTimezone}`)
      }
    }

    return NextResponse.json({
      timezone: detectedTimezone,
      country,
      city,
      region,
      source: "vercel-headers",
    })
  } catch (error) {
    console.error("Error detecting timezone:", error)
    return NextResponse.json({
      timezone: "UTC",
      error: "Detection failed",
      source: "fallback",
    })
  }
}
