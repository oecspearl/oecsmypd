import { NextRequest, NextResponse } from "next/server";
import { createServiceSupabaseClient } from "@/lib/supabase-server";
import { sendEmail, wrapEmailTemplate } from "@/lib/email-service";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { badRequest, tooManyRequests, serverError } from "@/lib/api-errors";

/**
 * POST /api/auth/forgot-password  { email }
 *
 * Generates a password-recovery token with the Supabase admin API and emails
 * it through Resend (the app's transactional mailer). This deliberately does
 * NOT use Supabase's built-in mailer, whose default rate limit is a couple
 * of emails per hour project-wide.
 *
 * Always responds with the same message whether or not the address exists,
 * so the endpoint cannot be used to enumerate accounts. Rate limited per IP
 * and per email.
 */

const GENERIC_MESSAGE =
  "If an account exists for that email address, a password reset link has been sent. Check your spam folder if it does not arrive within a few minutes.";

function appOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (configured && !/localhost/.test(configured)) return configured.replace(/\/+$/, "");
  return request.nextUrl.origin;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const ipLimit = await rateLimit({ key: `forgot-password:ip:${ip}`, limit: 5, windowSeconds: 900 });
    if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter);

    let body: any;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid request body");
    }

    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return badRequest("Please enter a valid email address");
    }

    const emailLimit = await rateLimit({ key: `forgot-password:email:${email}`, limit: 3, windowSeconds: 3600 });
    if (!emailLimit.ok) {
      // Respond generically: the address owner is protected from spam and an
      // attacker learns nothing.
      return NextResponse.json({ message: GENERIC_MESSAGE });
    }

    const origin = appOrigin(request);
    const resetPage = `${origin}/auth/reset-password`;
    const supabase = createServiceSupabaseClient();

    const { data, error } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: resetPage },
    });

    if (error || !data?.properties?.hashed_token) {
      // "User not found" lands here too; never reveal that to the caller.
      const status = (error as any)?.status;
      if (status !== 404 && !/not found/i.test(error?.message || "")) {
        console.error("[forgot-password] generateLink failed:", status, error?.message);
      }
      return NextResponse.json({ message: GENERIC_MESSAGE });
    }

    // Our own link: the reset page verifies token_hash with verifyOtp().
    // This avoids the Supabase /verify redirect hop and works in any browser.
    const link = `${resetPage}?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=recovery`;

    const name = (data.user?.user_metadata?.full_name || data.user?.user_metadata?.name || "").toString().trim();
    const greeting = name ? `Hi ${escapeHtml(name)},` : "Hello,";

    const html = wrapEmailTemplate(
      `
      <h2 style="margin: 0 0 16px; color: #1e293b;">Reset your password</h2>
      <p style="margin: 0 0 12px; color: #475569;">${greeting}</p>
      <p style="margin: 0 0 20px; color: #475569;">
        We received a request to reset the password for your OECS MyPD account.
        Click the button below to choose a new password. This link expires in one hour and can only be used once.
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Reset password</a>
      </p>
      <p style="margin: 0 0 12px; color: #64748b; font-size: 13px;">
        If the button does not work, copy and paste this address into your browser:<br />
        <a href="${link}" style="color: #2563eb; word-break: break-all;">${link}</a>
      </p>
      <p style="margin: 0; color: #64748b; font-size: 13px;">
        If you did not request a password reset, you can ignore this email. Your password will not change.
      </p>
      `,
      { title: "Reset your password" }
    );

    const sent = await sendEmail({
      to: email,
      subject: "Reset your OECS MyPD password",
      html,
      text: `We received a request to reset your OECS MyPD password. Open this link to choose a new one (expires in one hour): ${link}\n\nIf you did not request this, ignore this email.`,
      tags: [{ name: "category", value: "password-reset" }],
    });

    if (!sent.success) {
      console.error("[forgot-password] email send failed:", sent.error, sent.suggestion || "");
    }

    return NextResponse.json({ message: GENERIC_MESSAGE });
  } catch (error) {
    return serverError("Unable to process the request right now", error);
  }
}
