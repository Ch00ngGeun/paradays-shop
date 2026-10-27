import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCampaignEmail,
  CAMPAIGN_LOGO,
  campaignChannelSupport,
} from "@/lib/admin-ui/campaign-message";

describe("campaign email body template", () => {
  it("always puts the existing PARADAYS logo first as an inline Content-ID image", () => {
    const email = buildCampaignEmail({
      title: "신상품 안내",
      body: "새 데크가 나왔습니다.",
    });
    const body = email.html.slice(email.html.indexOf("<body"));
    const firstTag = body.slice(body.indexOf(">") + 1).match(/<img[^>]*>/)!;
    expect(body.indexOf(firstTag[0])).toBeLessThan(body.indexOf("신상품 안내"));
    expect(firstTag[0]).toContain(`src="cid:${CAMPAIGN_LOGO.contentId}"`);
    expect(firstTag[0]).toContain('alt="PARADAYS"');
    expect(email.inlineImages).toEqual([
      {
        contentId: CAMPAIGN_LOGO.contentId,
        path: "/brand/paradays-logo.jpg",
        fileName: "paradays-logo.jpg",
        contentType: "image/jpeg",
        disposition: "inline",
      },
    ]);
    expect(existsSync(join(process.cwd(), "public", CAMPAIGN_LOGO.path))).toBe(true);
    // No remote image: mail clients that block remote content still show the logo.
    expect(email.html).not.toMatch(/src="https?:/);
    expect(email.html.match(/<img/g)).toHaveLength(1);
  });

  it("escapes markup, keeps line breaks and flattens the subject header", () => {
    const email = buildCampaignEmail({
      title: "할인\r\nBcc: x@example.test",
      body: '<script>alert("x")</script>\n둘째 줄\n\n새 문단 & 링크',
    });
    expect(email.subject).toBe("할인 Bcc: x@example.test");
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>둘째 줄",
    );
    expect(email.html).toContain('<p style="margin:0 0 16px">새 문단 &amp; 링크</p>');
    expect(email.text).toBe(
      'PARADAYS\n\n할인 Bcc: x@example.test\n\n<script>alert("x")</script>\n둘째 줄\n\n새 문단 & 링크',
    );
  });

  it("rejects an empty title or message instead of producing a logo-only mail", () => {
    expect(() => buildCampaignEmail({ title: " ", body: "본문" })).toThrow();
    expect(() => buildCampaignEmail({ title: "제목", body: "\n" })).toThrow();
  });

  it("states per-channel image support and that no channel sends yet", () => {
    expect(campaignChannelSupport("email")).toMatchObject({
      inlineLogo: true,
      sendingConnected: false,
    });
    expect(campaignChannelSupport("sms")).toMatchObject({
      inlineLogo: false,
      sendingConnected: false,
    });
    expect(campaignChannelSupport("sms").detail).toContain("MMS");
    expect(campaignChannelSupport("push").inlineLogo).toBe(false);
  });
});
