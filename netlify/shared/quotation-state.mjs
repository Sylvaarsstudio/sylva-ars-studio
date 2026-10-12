function isQuotationExpired(quotation, now = new Date()) {
  if (!quotation?.expires_at) return false;
  return now.getTime() > new Date(quotation.expires_at).getTime();
}

export { isQuotationExpired };
