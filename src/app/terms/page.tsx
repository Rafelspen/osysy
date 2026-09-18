import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";
import { CONTACT_EMAIL, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = { title: `Terms of Service — ${SITE_NAME}` };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        By connecting a Google account or otherwise using {SITE_NAME} (&ldquo;the app&rdquo;), you agree to these terms. If
        you do not agree, do not use the app.
      </p>

      <Section title="What the app does">
        <p>
          The app reads a Google Sheet you choose, looks for business contact emails on the websites listed there, and
          creates drafts in your Gmail for you to review. It <strong>never sends email</strong>. You review every draft and
          decide whether to send it.
        </p>
      </Section>

      <Section title="Your responsibilities">
        <ul className="list-disc space-y-1 pl-5">
          <li>You are responsible for everything you send and to whom, and for having a lawful basis to contact them.</li>
          <li>
            You must follow the laws that apply to your outreach, including anti-spam and privacy rules such as CAN-SPAM,
            GDPR/PECR and similar laws where your recipients are located, and honour opt-out requests.
          </li>
          <li>Do not use the app for spam, harassment, deception, phishing, or any unlawful purpose.</li>
          <li>You must have the right to use the Google account and Sheet you connect, and keep your account secure.</li>
          <li>
            Follow Google&rsquo;s terms and policies for Gmail and Sheets. Email providers may filter or limit messages, and
            we cannot guarantee delivery.
          </li>
        </ul>
      </Section>

      <Section title="Accuracy of results">
        <p>
          Email addresses are collected from public web pages and checked only for format and whether the domain can receive
          mail. We do not guarantee that an address is correct, current, or belongs to the intended person or company. Check
          each draft before sending.
        </p>
      </Section>

      <Section title="Your data and privacy">
        <p>
          Your leads and drafts stay in your own Google account. How we handle data is described in our{" "}
          <a className="underline" href="/privacy">
            Privacy Policy
          </a>
          . You can disconnect at any time by revoking access at myaccount.google.com/permissions.
        </p>
      </Section>

      <Section title="Availability and changes">
        <p>
          The app is provided as it is and may change, be interrupted, or be discontinued at any time. Connections to Google
          can expire or be revoked, and you may need to reconnect.
        </p>
      </Section>

      <Section title="No warranty and limitation of liability">
        <p>
          To the fullest extent permitted by law, the app is provided &ldquo;as is&rdquo; without warranties of any kind, and
          we are not liable for indirect or consequential damages, lost profits, lost data, or harm arising from emails you
          send or from your use of the app.
        </p>
      </Section>

      <Section title="Suspension and termination">
        <p>
          We may suspend or end access if these terms are violated or if needed to protect the service, other users, or
          compliance with the law. You may stop using the app at any time.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          We may update these terms and will change the date above when we do; continued use means you accept the update.
          Questions:{" "}
          <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
