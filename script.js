const FORM_ENDPOINT =
  "https://docs.google.com/forms/d/e/1FAIpQLSd_95rK_6rrwu0H8L_O4tbBEwD36MHkcLIJQYasMXuY8SQodg/formResponse";

const lead = {
  projectType: "",
  propertyType: "",
  roofingSystem: "",
  projectDescription: "",
  propertyAddress: "",
  timing: "",
  name: "",
  phone: "",
  email: "",
  contactPreference: "",
  consent: false
};

let currentStep = 1;

const funnel = document.querySelector(".funnel");
const stepCard = document.querySelector(".form-step");
const progressLabel = document.querySelector(".progress span");
const progressBar = document.querySelector("progress");
const startButton = document.querySelector("#start-request");

function updateProgress(step) {
  currentStep = step;

  progressLabel.textContent = `Step ${step} of 5`;
  progressBar.value = step;
  progressBar.max = 5;
}

function scrollToFunnel() {
  funnel.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

startButton.addEventListener("click", scrollToFunnel);

function showStep1() {
  updateProgress(1);
  showRoofingNeed();
}

function showRoofingNeed() {
  updateProgress(1);

  stepCard.innerHTML = ` 
    <h2>What type of roofing help do you need?</h2>

    <button type="button" data-value="Roof Replacement">
      Roof Replacement
    </button>

    <button type="button" data-value="Roof Repair">
      Roof Repair
    </button>

    <button type="button" data-value="Leak / Storm Damage">
      Leak / Storm Damage
    </button>

    <button type="button" data-value="Roof Inspection">
      Roof Inspection
    </button>

    <button type="button" data-value="Not Sure">
      Not Sure
    </button>
  `;

  stepCard.querySelectorAll("[data-value]").forEach(button => {
    button.addEventListener("click", () => {
      lead.projectType = button.dataset.value;
      showPropertyType();
    });
  });
}

function showPropertyType() {
  updateProgress(1);

  stepCard.innerHTML = ` 
    <h2>What type of property is this?</h2>

    <button type="button" data-value="Single-Family Home">
      Single-Family Home
    </button>

    <button type="button" data-value="Multi-Family Home">
      Multi-Family Home
    </button>

    <button type="button" data-value="Commercial Property">
      Commercial Property
    </button>

    <button type="button" data-value="Other">
      Other
    </button>

    <button type="button" class="back-button" id="back-property-type">
      Back
    </button>
  `;

  stepCard.querySelectorAll("[data-value]").forEach(button => {
    button.addEventListener("click", () => {
      lead.propertyType = button.dataset.value;
      showRoofingSystem();
    });
  });

  document
    .querySelector("#back-property-type")
    .addEventListener("click", showRoofingNeed);
}

function showRoofingSystem() {
  updateProgress(1);

  stepCard.innerHTML = `
    <h2>What type of roofing system are you interested in?</h2>

    <button type="button" data-value="Asphalt Shingles">
      Asphalt Shingles
    </button>

    <button type="button" data-value="Metal Roofing">
      Metal Roofing
    </button>

    <button type="button" data-value="Slate Roofing">
      Slate Roofing
    </button>

    <button type="button" data-value="Flat / Low-Slope Roofing">
      Flat / Low-Slope Roofing
    </button>

    <button type="button" data-value="Rubber / EPDM">
      Rubber / EPDM
    </button>

    <button type="button" data-value="TPO / PVC">
      TPO / PVC
    </button>

    <button type="button" data-value="Not Sure">
      Not Sure
    </button>

    <button type="button" data-value="Other">
      Other
    </button>

    <button type="button" class="back-button" id="back-roofing-system">
      Back
    </button>
  `;

  stepCard.querySelectorAll("[data-value]").forEach(button => {
    button.addEventListener("click", () => {
      lead.roofingSystem = button.dataset.value;
      showStep2();
    });
  });

  document
    .querySelector("#back-roofing-system")
    .addEventListener("click", showPropertyType);
}

function showStep2() {
  updateProgress(2);

  stepCard.innerHTML = `
    <h2>Where is the property?</h2>

    <p class="step-help">
      Enter the address where roofing help is needed.
    </p>

    <input
      id="property-address"
      type="text"
      placeholder="Property address"
      autocomplete="street-address"
    >

    <p class="step-help">
      Anything we should know about the roof?
    </p>

    <textarea
      id="project-description"
      placeholder="Optional — leaks, roof age, damage, concerns, or other details"
      rows="4"
    ></textarea>

    <button type="button" id="continue-step-2">
      Continue
    </button>

    <button type="button" class="back-button" id="back-step-2">
      Back
    </button>
  `;

  document
    .querySelector("#continue-step-2")
    .addEventListener("click", () => {
      const address =
        document.querySelector("#property-address").value.trim();

      const description =
        document.querySelector("#project-description").value.trim();

      if (!address) {
        alert("Please enter the property address.");
        return;
      }

      lead.propertyAddress = address;
      lead.projectDescription = description;

      showStep3();
    });

  document
    .querySelector("#back-step-2")
    .addEventListener("click", showRoofingSystem);
}

function showStep3() {
  updateProgress(3);

  stepCard.innerHTML = `
    <h2>How soon are you looking to get this handled?</h2>

    <button type="button" data-value="As Soon As Possible">
      As Soon As Possible
    </button>

    <button type="button" data-value="Within 30 Days">
      Within 30 Days
    </button>

    <button type="button" data-value="1–3 Months">
      1–3 Months
    </button>

    <button type="button" data-value="3+ Months">
      3+ Months
    </button>

    <button type="button" data-value="Just Researching">
      Just Researching
    </button>

    <button type="button" class="back-button" id="back-step-3">
      Back
    </button>
  `;

  stepCard.querySelectorAll("[data-value]").forEach(button => {
    button.addEventListener("click", () => {
      lead.timing = button.dataset.value;
      showStep4();
    });
  });

  document
    .querySelector("#back-step-3")
    .addEventListener("click", showStep2);
}

function showStep4() {
  updateProgress(4);

  stepCard.innerHTML = `
    <h2>Where should we reach you?</h2>

    <input
      id="lead-name"
      type="text"
      placeholder="Full name"
      autocomplete="name"
    >

    <input
      id="lead-phone"
      type="tel"
      placeholder="Phone number"
      autocomplete="tel"
    >

    <input
      id="lead-email"
      type="email"
      placeholder="Email address"
      autocomplete="email"
    >

    <p class="step-help">
      What's the best way to contact you?
    </p>

    <div class="contact-options">
      <label>
        <input type="radio" name="contact" value="Call">
        Call
      </label>

      <label>
        <input type="radio" name="contact" value="Text">
        Text
      </label>

      <label>
        <input type="radio" name="contact" value="Email">
        Email
      </label>
    </div>

    <button type="button" id="continue-step-4">
      Continue
    </button>

    <button type="button" class="back-button" id="back-step-4">
      Back
    </button>
  `;

  document
    .querySelector("#continue-step-4")
    .addEventListener("click", () => {
      const name =
        document.querySelector("#lead-name").value.trim();

      const phone =
        document.querySelector("#lead-phone").value.trim();

      const email =
        document.querySelector("#lead-email").value.trim();

      const contact = document.querySelector(
        'input[name="contact"]:checked'
      );

      if (!name || !phone || !email || !contact) {
        alert("Please complete all contact information.");
        return;
      }

      lead.name = name;
      lead.phone = phone;
      lead.email = email;
      lead.contactPreference = contact.value;

      showStep5();
    });

  document
    .querySelector("#back-step-4")
    .addEventListener("click", showStep3);
}

function showStep5() {
  updateProgress(5);

  stepCard.innerHTML = `
    <h2>Review your request</h2>

    <div class="review">
      <p>
        <strong>Roofing need:</strong>
        ${escapeHTML(lead.projectType)}
      </p>

      <p>
        <strong>Property type:</strong>
        ${escapeHTML(lead.propertyType)}
      </p>

      <p>
        <strong>Roofing system:</strong>
        ${escapeHTML(lead.roofingSystem)}
      </p>

      <p>
        <strong>Property:</strong>
        ${escapeHTML(lead.propertyAddress)}
      </p>

      ${
        lead.projectDescription
          ? `
            <p>
              <strong>Roof details:</strong>
              ${escapeHTML(lead.projectDescription)}
            </p>
          `
          : ""
      }

      <p>
        <strong>Timing:</strong>
        ${escapeHTML(lead.timing)}
      </p>

      <p>
        <strong>Name:</strong>
        ${escapeHTML(lead.name)}
      </p>

      <p>
        <strong>Phone:</strong>
        ${escapeHTML(lead.phone)}
      </p>

      <p>
        <strong>Email:</strong>
        ${escapeHTML(lead.email)}
      </p>

      <p>
        <strong>Preferred contact:</strong>
        ${escapeHTML(lead.contactPreference)}
      </p>
    </div>

    <label class="consent">
      <input type="checkbox" id="consent-checkbox">

      <span>
        I agree that Builtegrity may contact me about my request
        and may share my information with a roofing professional
        who can assist with my project.
      </span>
    </label>

    <button type="button" id="submit-request">
      Submit My Request
    </button>

    <button type="button" class="back-button" id="back-step-5">
      Back
    </button>
  `;

  document
    .querySelector("#submit-request")
    .addEventListener("click", submitLead);

  document
    .querySelector("#back-step-5")
    .addEventListener("click", showStep4);
}

async function submitLead() {
  const consent =
    document.querySelector("#consent-checkbox").checked;

  if (!consent) {
    alert("Please agree before submitting your request.");
    return;
  }

  lead.consent = true;

  const submitButton =
    document.querySelector("#submit-request");

  submitButton.disabled = true;
  submitButton.textContent = "Submitting...";

  const formData = new URLSearchParams();

  formData.append("entry.1843216824", lead.propertyType);
  formData.append("entry.1447183842", lead.roofingSystem);
  formData.append("entry.601359630", lead.projectType);
  formData.append("entry.398908205", lead.projectDescription);
  formData.append("entry.1756618627", lead.propertyAddress);
  formData.append("entry.948050577", lead.timing);
  formData.append("entry.25475913", lead.name);
  formData.append("entry.1091292774", lead.phone);
  formData.append("entry.569954132", lead.email);
  formData.append(
    "entry.1118299552",
    lead.contactPreference
  );
  formData.append("entry.197004301", "I Agree");

  try {
    await fetch(FORM_ENDPOINT, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    });

    showSuccess();
  } catch (error) {
    console.error("Lead submission failed:", error);

    submitButton.disabled = false;
    submitButton.textContent = "Submit My Request";

    alert(
      "We couldn't submit your request. Please try again."
    );
  }
}

function showSuccess() {
  progressLabel.textContent = "Request received";
  progressBar.value = 5;

  stepCard.innerHTML = `
    <h2>You're all set.</h2>

    <p class="step-help">
      We received your roofing request.
      Builtegrity will review the information you provided
      and follow up using your preferred contact method.
    </p>

    <p>
      <strong>Questions?</strong><br>
      hello@builtegrity.com
    </p>
  `;

  scrollToFunnel();
}

showStep1();
