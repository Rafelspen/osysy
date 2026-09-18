import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";
import { CONTACT_EMAIL, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = { title: `Privacy Policy — ${SITE_NAME}` };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        {SITE_NAME} (&ldquo;the app&rdquo;, &ldquo;we&rdquo;) helps you prepare outreach emails. It reads a Google Sheet
        that you choose, finds business contact emails on the public websites listed in that Sheet, and creates
        <strong> drafts</strong> in your Gmail account for you to review and send yourself. This policy explains what data
        the app accesses, how it is used, and how to remove it.
      </p>

      <Section title="Data we access from your Google account">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Gmail (gmail.compose):</strong> to create and update draft emails, and to read back the drafts the app
            created so it can confirm they were saved correctly. The app never sends email.
          </li>
          <li>
            <strong>Gmail (gmail.readonly):</strong> used only to look at the conversation thread of an outreach email the app
            drafted, so that follow-up drafts can be placed in the same thread. For that thread the app reads only message
            headers and labels (the message ID, subject, and whether each message was sent, drafted or received). It does not
            read message bodies, and it does not read, search or store any other mail in your account.
          </li>
          <li>
            <strong>Google Sheets (spreadsheets):</strong> to read the lead rows in the Sheet you connect and to write
            progress information back to it (stage, found email addresses, status and error notes).
          </li>
        </ul>
      </Section>

      <Section title="Data we store">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Your Google OAuth refresh token, <strong>encrypted at rest</strong>, and a short-lived access token, so the app
            can keep working without asking you to sign in again each time.
          </li>
          <li>The link to your Sheet, your email template texts, and run logs (counts and error messages).</li>
          <li>
            Gmail thread and draft IDs are kept in your own Sheet (not in our database) so follow-ups can find the right
            thread.
          </li>
        </ul>
        <p>
          Your lead data stays in <strong>your own Google Sheet</strong>, and drafts stay in <strong>your own Gmail</strong>;
          we do not keep a separate copy of them in our database.
        </p>
      </Section>

      <Section title="How we use it">
        <p>
          Only to provide the features described above. We do not sell your data, use it for advertising, share it with
          third parties for their own purposes, or use it to train artificial intelligence or machine-learning models. A
          person on our side reads your data only if you ask for support or it is required by law.
        </p>
        <p>
          The app&rsquo;s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            className="underline"
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section title="Public websites the app visits">
        <p>
          To find business contact emails, the app requests public web pages of the websites you list in your Sheet, and
          performs a DNS lookup on email domains to check that they can receive mail. It only collects addresses that are
          published on those sites.
        </p>
      </Section>

      <Section title="Service providers">
        <p>
          The app is hosted on Vercel, keeps its database with Neon (Postgres), and its source code and scheduled trigger run
          on GitHub. These providers process data only to run the service.
        </p>
      </Section>

      <Section title="Retention and deletion">
        <p>
          We keep your connection data until you disconnect or ask us to delete it. You can revoke the app&rsquo;s access at
          any time at{" "}
          <a className="underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            myaccount.google.com/permissions
          </a>
          , which immediately stops all access. To have your stored data (tokens, template, logs) deleted, email us at the
          address below. Drafts and Sheet contents are in your Google account and remain under your control.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Tokens are encrypted before storage and traffic uses HTTPS. No system is perfectly secure, but we take reasonable
          steps to protect your data.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          We may update this policy and will change the date above when we do. Questions or deletion requests:{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
