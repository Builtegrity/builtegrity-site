const lead = {
  projectType: "",
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
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

startButton.addEventListener("click", scrollToFunnel);

function showStep1() {
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
      showStep2();
    });
  });
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

      if (!address) {
        alert("Please enter the property address.");
        return;
      }

      lead.propertyAddress = address;
      showStep3();
    });

  document
    .querySelector("#back-step-2")
    .addEventListener("click", showStep1);
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

    <p class="step-help">Best way to contact you:</p>

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
      const name = document.querySelector("#lead-name").value.trim();
      const phone = document.querySelector("#lead-phone").value.trim();
      const email = document.querySelector("#lead-email").value.trim();
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
        <strong>Property:</strong>
        ${escapeHTML(lead.propertyAddress)}
      </p>

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
    .addEventListener("click", () => {
      const consent =
        document.querySelector("#consent-checkbox").checked;

      if (!consent) {
        alert("Please agree before submitting your request.");
        return;
      }

      lead.consent = true;

      alert(
        "The funnel is working. Next we will connect this button to Builtegrity's lead system."
      );
    });

  document
    .querySelector("#back-step-5")
    .addEventListener("click", showStep4);
}

showStep1();
