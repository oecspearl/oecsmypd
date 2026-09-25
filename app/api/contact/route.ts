import { NextRequest, NextResponse } from "next/server";
import { sendEmail, wrapEmailTemplate } from "@/lib/email-service";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/api-errors";

/**
 * Escape HTML to prevent XSS attacks
 */
function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Contact Form API
 * 
 * POST /api/contact
 * 
 * Handles contact form submissions and sends emails to the support team
 */
export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit({ key: `contact:${clientIp(request)}`, limit: 5, windowSeconds: 600 });
    if (!limited.ok) return tooManyRequests(limited.retryAfter);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body is required" }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    const email = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
    const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 300) : "";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 10000) : "";

    // Validate required fields
    if (!name || !email || !subject || !message) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    // Escape user input to prevent XSS attacks
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

    // Prepare email content
    const emailContent = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #2563eb; margin-bottom: 20px;">New Contact Form Submission</h2>
        
        <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <p style="margin: 10px 0;"><strong>From:</strong> ${safeName}</p>
          <p style="margin: 10px 0;"><strong>Email:</strong> <a href="mailto:${safeEmail}" style="color: #2563eb; text-decoration: none;">${safeEmail}</a></p>
          <p style="margin: 10px 0;"><strong>Subject:</strong> ${safeSubject}</p>
          <p style="margin: 10px 0;"><strong>Date:</strong> ${new Date().toLocaleString()}</p>
        </div>

        <div style="background-color: #ffffff; padding: 20px; border-left: 4px solid #2563eb; margin-bottom: 20px;">
          <h3 style="color: #1f2937; margin-top: 0;">Message:</h3>
          <p style="line-height: 1.6; white-space: pre-wrap;">${safeMessage}</p>
        </div>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
          <p style="color: #6b7280; font-size: 14px; margin: 0;">
            You can reply directly to this email to respond to ${safeName} at ${safeEmail}
          </p>
        </div>
      </div>
    `;

    const emailSubject = `Contact Form: ${subject.replace(/[\r\n]+/g, ' ')}`;
    const wrappedContent = wrapEmailTemplate(emailContent, { title: emailSubject });

    // Send email to support team
    const result = await sendEmail({
      to: 'mypdoecs@gmail.com',
      subject: emailSubject,
      html: wrappedContent,
      text: `New Contact Form Submission\n\nFrom: ${name}\nEmail: ${email}\nSubject: ${subject}\nDate: ${new Date().toLocaleString()}\n\nMessage:\n${message}`,
      replyTo: email, // Allow replying directly to the sender
      tags: [
        { name: 'type', value: 'contact_form' },
        { name: 'source', value: 'website' }
      ],
    });

    if (!result.success) {
      console.error('Failed to send contact form email:', result.error);
      return NextResponse.json(
        { error: "Failed to send message. Please try again later." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Your message has been sent successfully! We'll get back to you soon.",
      messageId: result.messageId
    });

  } catch (error: any) {
    console.error('Contact form error:', error);
    return NextResponse.json(
      { error: "An error occurred while processing your request. Please try again later." },
      { status: 500 }
    );
  }
}
