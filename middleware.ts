import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase-server";

// Paths that are always public (exact match)
const PUBLIC_PATHS = new Set([
  "/",
  "/about",
  "/events",
  "/blog",
  "/contact",
  "/offline",
  "/apply",
  "/privacy",
  "/terms",
  "/accessibility",
]);

// Path prefixes that are public
const PUBLIC_PREFIXES = ["/auth/", "/apply/", "/admissions", "/certificate/verify", "/certificate/share"];

// Static / infrastructure paths the middleware must never intercept
const BYPASS_PREFIXES = ["/api", "/_next", "/favicon", "/icon", "/apple-icon"];
const BYPASS_EXACT = new Set([
  "/service-worker.js",
  "/firebase-messaging-sw.js",
  "/site.webmanifest",
  "/robots.txt",
  "/sitemap.xml",
]);
const STATIC_EXT = /\.(png|jpg|jpeg|gif|svg|ico|webp|css|js|map|txt|woff2?|ttf)$/i;

function redirectToSignIn(request: NextRequest) {
  const url = new URL("/auth/signin", request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next && next !== "/") {
    url.searchParams.set("next", next);
  }
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  if (
    BYPASS_PREFIXES.some((p) => path.startsWith(p)) ||
    BYPASS_EXACT.has(path) ||
    STATIC_EXT.test(path)
  ) {
    return NextResponse.next();
  }

  const isPublicPath = PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
  if (isPublicPath) {
    return NextResponse.next();
  }

  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return redirectToSignIn(request);
    }

    // Look up the application role. Service client bypasses RLS on `users`.
    const serviceSupabase = createServiceSupabaseClient();
    let { data: userProfile, error: profileError } = await serviceSupabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profileError || !userProfile) {
      // First sign-in: create the application profile with the default role.
      const newUser = {
        id: user.id,
        email: user.email || "",
        name: (user.user_metadata?.full_name || user.user_metadata?.name || "") as string,
        role: "student",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: createdUser, error: createError } = await serviceSupabase
        .from("users")
        .insert([newUser])
        .select("role")
        .single();

      if (createError) {
        console.error("Middleware: failed to create user profile", createError.code);
        return redirectToSignIn(request);
      }
      userProfile = createdUser;
    }

    const role = userProfile.role as string;

    // Server-side role gate for admin and CRM areas. API routes do their own checks.
    if (path.startsWith("/admin") && !["admin", "super_admin"].includes(role)) {
      return NextResponse.redirect(new URL("/dashboard?denied=admin", request.url));
    }
    if (path.startsWith("/crm") && !["admin", "super_admin", "instructor"].includes(role)) {
      return NextResponse.redirect(new URL("/dashboard?denied=crm", request.url));
    }

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-user-id", user.id);
    requestHeaders.set("x-user-role", role);

    return NextResponse.next({ request: { headers: requestHeaders } });
  } catch (error) {
    console.error("Middleware error:", error instanceof Error ? error.message : "unknown");
    return redirectToSignIn(request);
  }
}

export const config = {
  matcher: [
    // Everything except API routes, Next internals, and static assets.
    "/((?!api|_next/static|_next/image|favicon.ico|service-worker.js|firebase-messaging-sw.js|site.webmanifest|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|txt|woff2?|ttf)$).*)",
  ],
};
