const FORM_ENDPOINT = "https://docs.google.com/forms/d/e/1FAIpQLSd_95rK_6rrwu0H8L_O4tbBEwD36MHkcLIJQYasMXuY8SQodg/formResponse";

const lead = {
  projectType: "", propertyType: "", roofingSystem: "", projectDescription: "",
  propertyAddress: "", relatedNeeds: [], timing: "", name: "", phone: "",
  email: "", contactPreference: "", consent: false
};

const stepCard = document.querySelector("#request-form");
const progressLabel = document.querySelector("#progress-label");
const progressTopic = document.querySelector("#progress-topic");
const progressFill = document.querySelector("#progress-fill");
const topics = ["Roofing need", "Property", "Timing", "Contact", "Review"];

function updateProgress(step) {
  progressLabel.textContent = `Step ${step} of 5`;
  progressTopic.textContent = topics[step - 1];
  progressFill.style.width = `${step * 20}%`;
}

function escapeHTML(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function errorRegion() {
  return '<p class="error-message" id="form-error" role="alert"></p>';
}

function showError(message, focusSelector) {
  const error = document.querySelector("#form-error");
  error.textContent = message;
  error.classList.add("visible");
  if (focusSelector) document.querySelector(focusSelector)?.focus();
}

function optionButton(value, label = value) {
  return `<button class="option-button" type="button" data-value="${escapeHTML(value)}">${escapeHTML(label)}</button>`;
}

function bindOptions(next) {
  stepCard.querySelectorAll("[data-value]").forEach(button => {
    button.addEventListener("click", () => next(button.dataset.value));
  });
}

function showRoofingNeed() {
  updateProgress(1);
  stepCard.innerHTML = `<h2>What type of roofing help do you need?</h2><p class="step-help">Choose the option closest to what is happening.</p><div class="option-grid">${[
    "Roof Replacement", "Roof Repair", "Leak / Storm Damage", "Roof Inspection", "Not Sure"
  ].map(value => optionButton(value)).join("")}</div>`;
  bindOptions(value => { lead.projectType = value; showPropertyType(); });
}

function showPropertyType() {
  updateProgress(1);
  stepCard.innerHTML = `<h2>What type of property is this?</h2><p class="step-help">This helps us check project fit and coverage.</p><div class="option-grid">${[
    "Single-Family Home", "Multi-Family Home", "Commercial Property", "Other"
  ].map(value => optionButton(value)).join("")}</div><div class="form-actions"><button class="back-button" type="button" id="back">Back</button></div>`;
  bindOptions(value => { lead.propertyType = value; showRoofingSystem(); });
  document.querySelector("#back").addEventListener("click", showRoofingNeed);
}

function showRoofingSystem() {
  updateProgress(1);
  stepCard.innerHTML = `<h2>What kind of roof are you looking for?</h2><p class="step-help">It is okay if you are unsure. A roofing professional must make the technical determination.</p><div class="option-grid">${[
    "Asphalt Shingles", "Metal Roofing", "Slate Roofing", "Flat / Low-Slope Roofing",
    "Rubber / EPDM", "TPO / PVC", "Not Sure", "Other"
  ].map(value => optionButton(value)).join("")}</div><div class="form-actions"><button class="back-button" type="button" id="back">Back</button></div>`;
  bindOptions(value => { lead.roofingSystem = value; showStep2(); });
  document.querySelector("#back").addEventListener("click", showPropertyType);
}

function showStep2() {
  updateProgress(2);
  const needs = ["Siding", "Gutters", "Fascia / Trim", "Skylights", "Chimney / Flashing", "None", "Not Sure"];
  stepCard.innerHTML = `<h2>Where is the property?</h2>
    <label class="form-label" for="property-address">Property address</label>
    <input class="text-input" id="property-address" type="text" value="${escapeHTML(lead.propertyAddress)}" autocomplete="street-address" placeholder="Street, city, state and ZIP">
    <p class="field-note">Please enter the location where roofing help is needed.</p>
    <label class="form-label" for="project-description">What should we know about the roof?</label>
    <textarea class="text-area" id="project-description" placeholder="Optional — leaks, roof age, damage, concerns or other details">${escapeHTML(lead.projectDescription)}</textarea>
    <fieldset class="fieldset-reset"><legend class="form-label">Any related exterior needs?</legend><div class="checkbox-grid">${needs.map(value => `<label class="choice-label"><input type="checkbox" name="related" value="${value}" ${lead.relatedNeeds.includes(value) ? "checked" : ""}><span>${value}</span></label>`).join("")}</div></fieldset>
    ${errorRegion()}<div class="form-actions"><button class="button" type="button" id="continue">Continue</button><button class="back-button" type="button" id="back">Back</button></div>`;
  document.querySelector("#continue").addEventListener("click", () => {
    const address = document.querySelector("#property-address").value.trim();
    if (!address) return showError("Please enter the complete property address.", "#property-address");
    lead.propertyAddress = address;
    lead.projectDescription = document.querySelector("#project-description").value.trim();
    lead.relatedNeeds = [...document.querySelectorAll('input[name="related"]:checked')].map(input => input.value);
    if (lead.relatedNeeds.includes("None") && lead.relatedNeeds.length > 1) return showError("Choose either None or the related needs that apply.");
    showStep3();
  });
  document.querySelector("#back").addEventListener("click", showRoofingSystem);
}

function showStep3() {
  updateProgress(3);
  stepCard.innerHTML = `<h2>How soon are you looking to get this handled?</h2><p class="step-help">Choose the timing that best reflects your plans.</p><div class="option-grid">${[
    "As Soon As Possible", "Within 30 Days", "1–3 Months", "3+ Months", "Just Researching"
  ].map(value => optionButton(value)).join("")}</div><div class="form-actions"><button class="back-button" type="button" id="back">Back</button></div>`;
  bindOptions(value => { lead.timing = value; showStep4(); });
  document.querySelector("#back").addEventListener("click", showStep2);
}

function showStep4() {
  updateProgress(4);
  stepCard.innerHTML = `<h2>Where should we reach you?</h2><p class="step-help">We use this information only as described in our Privacy Notice.</p>
    <label class="form-label" for="lead-name">Full name</label><input class="text-input" id="lead-name" type="text" value="${escapeHTML(lead.name)}" autocomplete="name">
    <label class="form-label" for="lead-phone">Phone number</label><input class="text-input" id="lead-phone" type="tel" value="${escapeHTML(lead.phone)}" autocomplete="tel" inputmode="tel">
    <label class="form-label" for="lead-email">Email address</label><input class="text-input" id="lead-email" type="email" value="${escapeHTML(lead.email)}" autocomplete="email" inputmode="email">
    <fieldset class="fieldset-reset"><legend class="form-label">Best way to contact you</legend><div class="contact-options">${["Call", "Text", "Email"].map(value => `<label class="choice-label"><input type="radio" name="contact" value="${value}" ${lead.contactPreference === value ? "checked" : ""}><span>${value}</span></label>`).join("")}</div></fieldset>
    ${errorRegion()}<div class="form-actions"><button class="button" type="button" id="continue">Continue</button><button class="back-button" type="button" id="back">Back</button></div>`;
  document.querySelector("#continue").addEventListener("click", () => {
    const name = document.querySelector("#lead-name").value.trim();
    const phone = document.querySelector("#lead-phone").value.trim();
    const email = document.querySelector("#lead-email").value.trim();
    const contact = document.querySelector('input[name="contact"]:checked');
    if (!name) return showError("Please enter your full name.", "#lead-name");
    if (!phone) return showError("Please enter your phone number.", "#lead-phone");
    if (!email || !document.querySelector("#lead-email").checkValidity()) return showError("Please enter a valid email address.", "#lead-email");
    if (!contact) return showError("Please choose the best way to contact you.");
    Object.assign(lead, { name, phone, email, contactPreference: contact.value });
    showStep5();
  });
  document.querySelector("#back").addEventListener("click", showStep3);
}

function reviewRow(label, value) {
  return `<div class="review-row"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(value || "Not provided")}</span></div>`;
}

function showStep5() {
  updateProgress(5);
  stepCard.innerHTML = `<h2>Review your request</h2><p class="step-help">Confirm the information before submitting.</p><div class="review">
    ${reviewRow("Roofing need", lead.projectType)}${reviewRow("Property type", lead.propertyType)}${reviewRow("Roof type", lead.roofingSystem)}${reviewRow("Property", lead.propertyAddress)}${reviewRow("Roof details", lead.projectDescription)}${reviewRow("Related needs", lead.relatedNeeds.join(", ") || "None selected")}${reviewRow("Timing", lead.timing)}${reviewRow("Name", lead.name)}${reviewRow("Phone", lead.phone)}${reviewRow("Email", lead.email)}${reviewRow("Preferred contact", lead.contactPreference)}</div>
    <label class="consent"><input type="checkbox" id="consent-checkbox"><span>I authorize Builtegrity to contact me about this request and to share my request information with one roofing professional selected to evaluate the opportunity. I have read the <a href="/privacy/" target="_blank">Privacy Notice</a> and <a href="/terms/" target="_blank">Terms</a>.</span></label>
    ${errorRegion()}<div class="form-actions"><button class="button" type="button" id="submit-request">Submit My Request</button><button class="back-button" type="button" id="back">Back</button></div>`;
  document.querySelector("#submit-request").addEventListener("click", submitLead);
  document.querySelector("#back").addEventListener("click", showStep4);
}

function createRequestReference() {
  const year = new Date().getFullYear();
  const time = Date.now().toString(36).toUpperCase().slice(-6);
  const random = Math.random().toString(36).toUpperCase().slice(2, 5);
  return `BG-R-${year}-${time}${random}`;
}

async function submitLead() {
  if (!document.querySelector("#consent-checkbox").checked) return showError("Please authorize contact and information sharing before submitting.", "#consent-checkbox");
  lead.consent = true;
  const button = document.querySelector("#submit-request");
  button.disabled = true; button.textContent = "Submitting…";
  const requestReference = createRequestReference();
  const attribution = window.builtegrityAttribution || { source: "Direct / unknown" };
  const formData = new URLSearchParams();
  formData.append("entry.1843216824", lead.propertyType);
  formData.append("entry.1447183842", lead.roofingSystem);
  formData.append("entry.601359630", lead.projectType);
  formData.append("entry.398908205", lead.projectDescription);
  formData.append("entry.2122069102", lead.relatedNeeds.join(", ") || "None selected");
  formData.append("entry.1366848857", requestReference);
  formData.append("entry.568624020", attribution.source || "Direct / unknown");
  formData.append("entry.430553536", attribution.utm_medium || "");
  formData.append("entry.843210747", attribution.utm_campaign || "");
  formData.append("entry.164856092", attribution.utm_content || "");
  formData.append("entry.1756618627", lead.propertyAddress);
  formData.append("entry.948050577", lead.timing);
  formData.append("entry.25475913", lead.name);
  formData.append("entry.1091292774", lead.phone);
  formData.append("entry.569954132", lead.email);
  formData.append("entry.1118299552", lead.contactPreference);
  formData.append("entry.197004301", "I Agree");
  try {
    await fetch(FORM_ENDPOINT, { method:"POST", mode:"no-cors", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:formData.toString() });
    try { sessionStorage.setItem("builtegrityRequestRef", requestReference); } catch {}
    location.assign(`/request/complete/?ref=${encodeURIComponent(requestReference)}`);
  } catch (error) {
    console.error("Request submission failed", error);
    button.disabled = false; button.textContent = "Submit My Request";
    showError("We could not send the request. Please check your connection and try again.");
  }
}

showRoofingNeed();
