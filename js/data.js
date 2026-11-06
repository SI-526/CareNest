// Demo families for ?demo=1 (and the demo.html start page). Signed-in pages never show these:
// js/family-data.js replaces window.CareNestData with the real family before anything renders.
//
// The babysitter demo (Bethany) sits for two families and switches between them with the
// "Family space" bar:
//   thomas  Jack Thomas, age 3, and Kylie Thomas, age 6 (parent: Mary Ann Thomas)
//   rivera  Sofia Rivera, age 6 (parent: Ana Rivera)
// The parent demo is Mary Ann Thomas, so both sides tell the same story about Jack and Kylie.
// Kylie has no food info on purpose, so the demo shows "No information provided" (SI-49).
//
// Food, preferences, and instructions live on each child (`children`); js/children.js flatten()
// rebuilds the family-wide lists the older pages read.
//
// Everything a tester changes (care info, contacts, sessions, check-offs, care logs, messages,
// the sitter profile) is kept in sessionStorage, so it lasts while the tab is open and is gone
// once the tab is closed. Nothing is sent to the database.
(function () {
  const DEMO_FLAG = "carenest:demo";
  const FAMILY_KEY = "carenest:demo:family";
  const dataKey = (familyId) => `carenest:demo:data:${familyId}`;
  const PARENT_PAGES = ["parent", "people", "manage"];

  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  function inDemo() {
    try {
      return (
        new URLSearchParams(window.location.search).has("demo") ||
        sessionStorage.getItem(DEMO_FLAG) === "1"
      );
    } catch (e) {
      return false;
    }
  }

  // Local calendar date `offsetDays` from today as YYYY-MM-DD (the schedule page's date key).
  function dateKey(offsetDays) {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  }

  function todayLabel() {
    return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function phoneHref(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length >= 3 ? `tel:${digits}` : "";
  }

  function contact(id, name, role, phone, avatar) {
    return { id, name, firstName: name.split(/\s+/)[0], role, phone, phoneHref: phoneHref(phone), address: "", avatar: avatar || null };
  }

  function task(id, time, title, detail, extra) {
    return Object.assign({ id, time, title, detail: detail || null, location: null, map: null, careNote: null, completed: false }, extra || {});
  }

  const SEVERITY_CLASS = { Severe: "badge--severe", Moderate: "badge--moderate", Mild: "badge--mild" };
  function allergy(id, name, severity, description, image) {
    return { id, name, severity, severityClass: SEVERITY_CLASS[severity] || "", image: image || null, description };
  }

  const KNOW_TILES = [
    { id: "food", label: "Food & allergies", icon: "assets/grocery.svg", href: "food-allergies.html" },
    { id: "preferences", label: "Preferences", icon: "assets/favorite.svg", href: "info.html?category=preferences" },
    { id: "where", label: "Where things are", icon: "assets/orders.svg", href: "info.html?category=where" },
    { id: "instructions", label: "Instructions", icon: "assets/assignment.svg", href: "info.html?category=instructions" },
  ];

  // ---------------------------------------------------------------- the Thomas family (Jack)

  function thomasFamily() {
    const schedule = [
      task("snack", "1:30pm", "Snack", "Apples and cheese"),
      task("playground", "3:00pm", "Playground", null, {
        location: "3175 Gallup Park Rd, Ann Arbor, MI 48104",
        map: "assets/map.png",
        careNote: "Spend ~1 hour playing. Make sure to pack snacks and drinks!",
      }),
      task("dinner", "5:00pm", "Dinner", "Pasta and vegetables"),
      task("wind-down", "7:00pm", "Wind down", "Bath time and reading"),
    ];
    const contacts = [
      contact("mary", "Mary Ann Thomas", "Parent", "588 - 909 - 3489", "assets/mary.png"),
      contact("david", "David Thomas", "Parent", "734 - 555 - 0142"),
      contact("linda", "Linda Thomas", "Grandmother", "616 - 555 - 0187"),
      contact("dr-shah", "Dr. Priya Shah", "Pediatrician", "734 - 555 - 0123"),
    ];
    return {
      familyName: "Thomas family",
      parentName: "Mary Ann Thomas",
      babysitter: { name: "Bethany", avatar: "assets/bethany.png", address: "51900 Beck St., Grand Rapids, MI, 48091" },
      child: { name: "Jack Thomas", age: "Age 3", avatar: null, dateLabel: todayLabel(), shiftTime: "3:00pm - 7:00pm" },
      homeAddress: "213 Maple Lane, Ann Arbor, MI 48104",
      primaryContactId: "mary",
      children: [
        {
          id: "jack",
          name: "Jack Thomas",
          age: "Age 3",
          stage: "Preschooler",
          pinnedNote: "",
          position: 0,
          careNote: "Epinephrine auto-injector (EpiPen) available in bathroom cabinet for use in the event of a severe allergic reaction.",
          food: [
            allergy("food-gluten", "Gluten-free", "Severe", "Avoid wheat, barley, and rye. Use separate utensils; check food labels.", "assets/gluten.png"),
            allergy("food-dairy", "Dairy-free", "Mild", "Avoid milk, cheese, and butter. Serve dairy-free alternatives.", "assets/dairy.png"),
            allergy("food-nuts", "Nut-free", "Severe", "Avoid nuts and nut traces. Follow the child’s allergy care plan.", "assets/nuts.png"),
          ],
          preferences: [
            { id: "pref-comfort", title: "Comfort item", detail: "Jack calms down with his blue stuffed elephant, Ellie. She usually lives on his bed." },
            { id: "pref-activities", title: "Favorite activities", detail: "Building with Duplo blocks, dinosaur books, and playing tag outside." },
            { id: "pref-foods", title: "Favorite foods", detail: "Apples, rice crackers, and pasta. Not a fan of broccoli, so offer peas instead." },
            { id: "pref-screens", title: "Screen time", detail: "Up to 30 minutes of PBS Kids on the living room TV. No tablets or phones." },
            { id: "pref-upset", title: "When he is upset", detail: "Offer a hug and count to five together. A quiet book on the couch usually helps." },
          ],
          instructions: [
            { id: "ins-labels", title: "Check every label", detail: "Only serve food that is gluten-, dairy-, and nut-free. When in doubt, don’t serve it." },
            { id: "ins-hands", title: "Handwashing", detail: "Wash hands before every meal and snack, and after the playground." },
            { id: "ins-outside", title: "Outside the house", detail: "Hold hands in parking lots and near the road. Put on sunscreen before the playground." },
            { id: "ins-bath", title: "Bath time", detail: "Keep the water lukewarm and never leave Jack alone in the tub, even for a moment." },
            { id: "ins-bed", title: "Bedtime", detail: "Pajamas, brush teeth, then two books. Lights out by 7:30pm with Ellie and the night light on." },
            { id: "ins-updates", title: "Updates for Mary", detail: "Send Mary a quick text after the playground and after dinner." },
          ],
        },
        {
          id: "kylie",
          name: "Kylie Thomas",
          age: "Age 6",
          stage: "1st Grader",
          pinnedNote: "Currently recovering from a cold",
          position: 1,
          careNote: "",
          food: [],
          preferences: [
            { id: "kylie-pref-reading", title: "Reading", detail: "Loves chapter books. She will read to you if you ask." },
          ],
          instructions: [
            { id: "kylie-ins-rest", title: "Rest", detail: "She is getting over a cold: quiet play inside, and plenty of water." },
          ],
        },
      ],
      dayNotes: [
        {
          id: "demo-pickup",
          category: "schedule",
          title: "Pick Jack up from soccer at 4:30pm",
          detail: "Practice runs late on Thursdays. Bring his water bottle; it's by the front door.",
          createdAt: Date.now() - 3 * HOUR,
          updatedAt: Date.now() - 3 * HOUR,
        },
        {
          id: "demo-meds",
          category: "food_meds",
          title: "Amoxicillin with dinner (5 ml)",
          detail: "The bottle is in the fridge door with the syringe next to it. Shake well first. He had his morning dose at 8am.",
          createdAt: Date.now() - 3 * HOUR,
          updatedAt: Date.now() - 25 * MINUTE,
        },
        {
          id: "demo-grandma",
          category: "other",
          title: "Grandma may stop by around 6pm",
          detail: "",
          createdAt: Date.now() - 2 * HOUR,
          updatedAt: Date.now() - 2 * HOUR,
        },
      ],
      contacts,
      schedule,
      appointments: [
        { id: "thomas-today", date: dateKey(0), start_time: "3:00 PM", end_time: "7:00 PM", note: "Soccer pickup at 4:30pm.", activities: schedule.map((t) => Object.assign({}, t)) },
        { id: "thomas-date-night", date: dateKey(3), start_time: "6:00 PM", end_time: "10:00 PM", note: "Date night. Jack's bedtime is 7:30pm.", activities: [] },
        { id: "thomas-saturday", date: dateKey(5), start_time: "11:00 AM", end_time: "5:00 PM", note: "", activities: [] },
      ],
      knowTiles: KNOW_TILES,
      categories: {
        preferences: { title: "Preferences", items: [] },
        where: {
          title: "Where things are",
          items: [
            { id: "where-epipen", title: "EpiPen", detail: "Bathroom cabinet, middle shelf. A second one is in the front pocket of the diaper bag." },
            { id: "where-firstaid", title: "First aid kit", detail: "Hall closet, top shelf, in the red zip bag." },
            { id: "where-snacks", title: "Snacks", detail: "Pantry, second shelf, in the bin labeled “Jack.” Everything in it is gluten-, dairy-, and nut-free." },
            { id: "where-pullups", title: "Pull-ups and wipes", detail: "Basket next to the dresser in Jack’s room." },
            { id: "where-clothes", title: "Spare clothes and pajamas", detail: "Bottom two drawers of Jack’s dresser." },
            { id: "where-stroller", title: "Stroller", detail: "Garage, just left of the door into the house." },
          ],
        },
        instructions: { title: "Instructions", items: [] },
        emergency: {
          title: "If something goes wrong",
          summary: "Emergency steps, hospital, and who to call",
          callout: { text: "If Jack or Kylie is in danger, not breathing, or having a severe allergic reaction, call 911 first.", label: "Call 911", href: "tel:911" },
          steps: [
            { id: "step-calm", title: "Stay calm.", detail: "Move Jack away from anything that could hurt him." },
            { id: "step-911", title: "Call 911 right away", detail: "if he is not breathing, will not wake up, is badly hurt, or is having a severe allergic reaction." },
            { id: "step-epipen", title: "Severe allergic reaction", detail: "(swelling, trouble breathing, hives): use the EpiPen from the bathroom cabinet on the outside of his thigh, then call 911." },
            { id: "step-poison", title: "Possible poisoning:", detail: "call Poison Control at 1-800-222-1222." },
            { id: "step-doctor", title: "Needs a doctor, not life-threatening:", detail: "drive him to the hospital below. Bring the diaper bag and his EpiPen." },
            { id: "step-call", title: "Call Mary", detail: "as soon as Jack is safe. If you cannot reach her, call the other contacts below in order." },
          ],
          hospital: {
            name: "C.S. Mott Children’s Hospital",
            system: "Michigan Medicine, Pediatric Emergency",
            address: "1540 E Hospital Dr, Ann Arbor, MI 48109",
            mapHref: "https://www.google.com/maps/search/?api=1&query=1540+E+Hospital+Dr%2C+Ann+Arbor%2C+MI+48109",
            phone: "734 - 555 - 0100",
            phoneHref: "tel:7345550100",
          },
          contacts,
        },
      },
      allergies: {
        title: "Food & allergies",
        sectionTitle: "Dietary restrictions",
        careNote: null,
        items: [],
      },
      // Today's shift as the tester finds it: the first two tasks done, with care logs.
      shiftSeed: {
        startedMinutesAgo: 95,
        completions: [
          { taskId: "snack", minutesAgo: 80, note: "Sliced apples and the dairy-free cheese from his bin." },
          { taskId: "playground", minutesAgo: 20, note: "" },
        ],
        logs: [
          { taskId: "snack", minutesAgo: 78, category: "meal", mealAmount: "most", note: "Ate all the apple slices, left about half the cheese." },
          { taskId: "playground", minutesAgo: 18, category: "care", note: "Sunscreen on at 3:00. Played tag and the big slide for an hour, no bumps or scrapes." },
          { taskId: "playground", minutesAgo: 15, category: "care", note: "Drank his whole water bottle. A little tired on the walk back." },
        ],
        messages: [
          { sender: "parent", minutesAgo: 70, body: "Thanks Bethany! He's been asking about the playground all week." },
          { sender: "sitter", minutesAgo: 14, body: "Back from the playground. He had a blast! Heading inside to start dinner prep." },
        ],
      },
    };
  }

  // ---------------------------------------------------------------- the Rivera family (Sofia)

  function riveraFamily() {
    const schedule = [
      task("rivera-pickup", "3:15pm", "School pickup", "Kindergarten pickup line, door B", {
        location: "Burns Park Elementary, 1414 Wells St, Ann Arbor, MI 48104",
        careNote: "Show your ID to the teacher. Sofia waits by the flagpole with Ms. Lee's class.",
      }),
      task("rivera-snack", "3:45pm", "After-school snack", "Clementine and whole-grain crackers"),
      task("rivera-homework", "4:30pm", "Reading and homework", "20 minutes of reading, then her worksheet"),
      task("rivera-piano", "5:30pm", "Piano practice", "15 minutes on the songs marked in her book"),
      task("rivera-dinner", "6:00pm", "Dinner", "Chicken quesadillas (egg-free tortillas) and cucumber"),
      task("rivera-bedtime", "7:30pm", "Bath and bedtime", "Bath, pajamas, one chapter of her book"),
    ];
    const contacts = [
      contact("ana", "Ana Rivera", "Parent", "734 - 555 - 0164"),
      contact("marco", "Marco Rivera", "Parent", "734 - 555 - 0178"),
      contact("rosa", "Rosa Delgado", "Aunt (lives nearby)", "734 - 555 - 0191"),
      contact("dr-okafor", "Dr. James Okafor", "Pediatrician", "734 - 555 - 0135"),
    ];
    return {
      familyName: "Rivera family",
      parentName: "Ana Rivera",
      babysitter: { name: "Bethany", avatar: "assets/bethany.png", address: "2214 Packard St, Ann Arbor, MI 48104" },
      child: { name: "Sofia Rivera", age: "Age 6", avatar: null, dateLabel: todayLabel(), shiftTime: "3:15pm - 8:00pm" },
      homeAddress: "1802 Granger Ave, Ann Arbor, MI 48104",
      primaryContactId: "ana",
      children: [
        {
          id: "sofia",
          name: "Sofia Rivera",
          age: "Age 6",
          stage: "Kindergartner",
          pinnedNote: "",
          position: 0,
          careNote: "Children's Benadryl is in the kitchen cabinet above the microwave. Sofia's allergy is not severe enough for an EpiPen.",
          food: [
            allergy("rivera-food-egg", "Egg-free", "Moderate", "No eggs or foods made with egg, including most baked goods and fresh pasta."),
            allergy("rivera-food-sugar", "Limit sweets", "Mild", "One small treat after dinner at most."),
          ],
          preferences: [
            { id: "rivera-pref-comfort", title: "Comfort item", detail: "A purple blanket called Moo. It lives on her bed and comes to the couch for reading." },
            { id: "rivera-pref-activities", title: "Favorite activities", detail: "Drawing, LEGO Friends, and dancing to the Encanto soundtrack." },
            { id: "rivera-pref-foods", title: "Favorite foods", detail: "Clementines, quesadillas, and rice. She'll try new vegetables if she can dip them." },
            { id: "rivera-pref-screens", title: "Screen time", detail: "One show after homework is finished. No screens after dinner." },
            { id: "rivera-pref-upset", title: "When she is upset", detail: "Give her a few minutes with Moo, then ask her to draw what happened. She opens up while drawing." },
          ],
          instructions: [
            { id: "rivera-ins-eggs", title: "No eggs", detail: "Check labels for egg, including baked goods and pasta. Her egg-free snacks have a green sticker." },
            { id: "rivera-ins-homework", title: "Homework", detail: "Reading first, then the worksheet. Help only if she asks; she likes to try first." },
            { id: "rivera-ins-outside", title: "Outside", detail: "She can ride her scooter on the sidewalk with a helmet. Not past the corner." },
            { id: "rivera-ins-bed", title: "Bedtime", detail: "Lights out at 8:00pm (7:45pm tonight). She sleeps with the hall light on." },
          ],
        },
      ],
      dayNotes: [
        {
          id: "rivera-library",
          category: "schedule",
          title: "Library books are due tomorrow",
          detail: "They're in the blue tote by the stairs. Please put them in her backpack tonight.",
          createdAt: Date.now() - 4 * HOUR,
          updatedAt: Date.now() - 4 * HOUR,
        },
        {
          id: "rivera-picture-day",
          category: "other",
          title: "Picture day tomorrow, bedtime by 7:45pm",
          detail: "Her outfit is hanging on the closet door.",
          createdAt: Date.now() - 2 * HOUR,
          updatedAt: Date.now() - 2 * HOUR,
        },
      ],
      contacts,
      schedule,
      appointments: [
        { id: "rivera-today", date: dateKey(0), start_time: "3:15 PM", end_time: "8:00 PM", note: "", activities: schedule.map((t) => Object.assign({}, t)) },
        { id: "rivera-tomorrow", date: dateKey(1), start_time: "3:15 PM", end_time: "6:00 PM", note: "Ana is home by 6.", activities: [] },
        { id: "rivera-next-week", date: dateKey(7), start_time: "3:15 PM", end_time: "8:00 PM", note: "", activities: [] },
      ],
      knowTiles: KNOW_TILES,
      categories: {
        preferences: { title: "Preferences", items: [] },
        where: {
          title: "Where things are",
          items: [
            { id: "rivera-where-key", title: "House key", detail: "Lockbox on the side door. Code is 4-2-1-6." },
            { id: "rivera-where-firstaid", title: "First aid kit", detail: "Under the kitchen sink, in the white box." },
            { id: "rivera-where-snacks", title: "Snacks", detail: "Fruit bowl on the counter, crackers in the pantry on the bottom shelf." },
            { id: "rivera-where-homework", title: "Homework folder", detail: "Front pocket of her backpack, the red folder." },
            { id: "rivera-where-pajamas", title: "Pajamas", detail: "Top drawer of her dresser." },
          ],
        },
        instructions: { title: "Instructions", items: [] },
        emergency: {
          title: "If something goes wrong",
          summary: "Emergency steps, hospital, and who to call",
          callout: { text: "If Sofia is in danger, not breathing, or having a severe allergic reaction, call 911 first.", label: "Call 911", href: "tel:911" },
          steps: [
            { id: "rivera-step-calm", title: "Stay calm.", detail: "Move Sofia away from anything that could hurt her." },
            { id: "rivera-step-911", title: "Call 911 right away", detail: "if she is not breathing, will not wake up, is badly hurt, or is having a severe allergic reaction." },
            { id: "rivera-step-allergy", title: "Allergic reaction to egg", detail: "(hives, swelling, vomiting): give the children's Benadryl in the kitchen cabinet (1 tsp), then call Ana." },
            { id: "rivera-step-poison", title: "Possible poisoning:", detail: "call Poison Control at 1-800-222-1222." },
            { id: "rivera-step-call", title: "Call Ana", detail: "as soon as Sofia is safe. If you cannot reach her, call Marco, then Rosa." },
          ],
          hospital: {
            name: "C.S. Mott Children’s Hospital",
            system: "Michigan Medicine, Pediatric Emergency",
            address: "1540 E Hospital Dr, Ann Arbor, MI 48109",
            mapHref: "https://www.google.com/maps/search/?api=1&query=1540+E+Hospital+Dr%2C+Ann+Arbor%2C+MI+48109",
            phone: "734 - 555 - 0100",
            phoneHref: "tel:7345550100",
          },
          contacts,
        },
      },
      allergies: {
        title: "Food & allergies",
        sectionTitle: "Dietary restrictions",
        careNote: null,
        items: [],
      },
      shiftSeed: {
        startedMinutesAgo: 70,
        completions: [
          { taskId: "rivera-pickup", minutesAgo: 60, note: "" },
          { taskId: "rivera-snack", minutesAgo: 35, note: "" },
        ],
        logs: [
          { taskId: "rivera-pickup", minutesAgo: 58, category: "care", note: "Picked up at 3:20 by the flagpole. Her teacher said she had a great day and read aloud to the class." },
          { taskId: "rivera-snack", minutesAgo: 33, category: "meal", mealAmount: "some", note: "Ate the clementine, only a few crackers." },
        ],
        messages: [
          { sender: "sitter", minutesAgo: 57, body: "Got Sofia! She's in a great mood." },
          { sender: "parent", minutesAgo: 50, body: "Yay, thank you! Don't forget piano tonight." },
        ],
      },
    };
  }

  const FAMILIES = { thomas: thomasFamily, rivera: riveraFamily };
  const FAMILY_IDS = Object.keys(FAMILIES);

  // The parent demo is always the Thomas family; the babysitter demo shows the family this tab
  // picked last (the Thomas family first).
  function isParentView() {
    const page = document.body && document.body.dataset.page;
    return PARENT_PAGES.includes(page) || new URLSearchParams(window.location.search).get("as") === "parent";
  }

  function chosenFamily() {
    try {
      const saved = sessionStorage.getItem(FAMILY_KEY);
      if (FAMILY_IDS.includes(saved)) return saved;
    } catch (e) {
      /* storage unavailable */
    }
    return "thomas";
  }

  const familyId = isParentView() ? "thomas" : chosenFamily();

  // What the pages read but the family does not store twice: each child's items as family-wide
  // lists (js/children.js), and the primary contact.
  function derive(data) {
    if (window.CareNestChildren) window.CareNestChildren.flatten(data);
    data.primaryContact = data.contacts.find((c) => c.id === data.primaryContactId) || null;
    data.categories.emergency.contacts = data.contacts; // one list, as when signed in
    nameChildren(data);
    return data;
  }

  function load(id) {
    if (inDemo()) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(dataKey(id)) || "null");
        // A tab saved before children existed has no `children`: start that family afresh.
        if (saved && typeof saved === "object" && Array.isArray(saved.children)) {
          saved.child.dateLabel = todayLabel();
          return derive(saved);
        }
      } catch (e) {
        /* unreadable: start from the sample */
      }
    }
    return derive(FAMILIES[id]());
  }

  window.CareNestData = load(familyId);

  // ---------------------------------------------------------------- demo helpers

  function save() {
    try {
      sessionStorage.setItem(dataKey(familyId), JSON.stringify(window.CareNestData));
      return null;
    } catch (e) {
      return new Error("This browser tab is out of storage space, so this wasn't saved.");
    }
  }

  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // "15:00:00" -> "3:00pm" (the editors send database-style times).
  function displayTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
    if (!match) return value || "";
    const hours = Number(match[1]);
    return `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]}${hours >= 12 ? "pm" : "am"}`;
  }

  const PER_CHILD = ["food", "preferences", "instructions"];

  function childById(id) {
    return window.CareNestData.children.find((child) => child.id === id) || null;
  }

  // The Call 911 callout names the children, as js/family-data.js does when signed in.
  function nameChildren(data) {
    if (window.CareNestChildren) data.categories.emergency.callout.text = window.CareNestChildren.emergencyText(data.children);
  }

  // The rows the parent editors (js/children-page.js, js/secondary.js) write, applied to this tab's demo
  // family. `scope` is { id } or { household_id } from .eq(). Returns { error, id }.
  function applyWrite(table, action, values, scope) {
    const data = window.CareNestData;
    values = values || {};
    const id = scope.id;
    let createdId = null;
    if (table === "households" && action === "update") {
      // An old-style save of the first child's name or age, as the database's sync trigger does.
      const first = data.children[0];
      if (first && "child_name" in values) first.name = values.child_name || "";
      if (first && "child_age_label" in values) first.age = values.child_age_label || "";
      if ("home_address" in values) data.homeAddress = values.home_address || "";
    } else if (table === "children") {
      const fields = {};
      if ("name" in values) fields.name = values.name || "";
      if ("age_label" in values) fields.age = values.age_label || "";
      if ("stage_label" in values) fields.stage = values.stage_label || "";
      if ("pinned_note" in values) fields.pinnedNote = values.pinned_note || "";
      if ("position" in values) fields.position = Number(values.position) || 0;
      if (action === "insert") {
        createdId = newId("child");
        data.children.push(Object.assign({ id: createdId, name: "", age: "", stage: "", pinnedNote: "", position: 0, careNote: "", food: [], preferences: [], instructions: [] }, fields));
      } else if (action === "delete") {
        // As the database cascades: the child's own items go with it.
        data.children = data.children.filter((child) => child.id !== id);
      } else {
        const child = childById(id);
        if (!child) return { error: new Error("That child is no longer here. Reload the page.") };
        Object.assign(child, fields);
      }
    } else if (table === "plans" && action === "update") {
      if ("schedule" in values) data.child.shiftTime = values.schedule || "";
    } else if (table === "tasks") {
      const fields = {
        title: values.title,
        time: displayTime(values.time_of_day),
        detail: values.detail || null,
        location: values.location || null,
      };
      if (action === "insert") data.schedule.push(task(newId("task"), fields.time, fields.title, fields.detail, { location: fields.location }));
      else if (values.archived_at) data.schedule = data.schedule.filter((t) => t.id !== id);
      else Object.assign(data.schedule.find((t) => t.id === id) || {}, fields);
    } else if (table === "contacts") {
      if ("is_primary" in values) {
        // One primary contact per family, as the database's unique index allows.
        if (values.is_primary) data.primaryContactId = id;
        else if (!id || data.primaryContactId === id) data.primaryContactId = null;
      }
      const fields = ["name", "role", "phone", "address"].filter((key) => key in values);
      if (action === "delete") {
        data.contacts = data.contacts.filter((c) => c.id !== id);
        if (data.primaryContactId === id) data.primaryContactId = null;
      } else if (action === "insert") {
        createdId = newId("contact");
        const row = contact(createdId, values.name || "Contact", values.role || "", values.phone || "");
        row.address = values.address || "";
        data.contacts.push(row);
        if (values.is_primary) data.primaryContactId = createdId;
      } else if (fields.length) {
        const existing = data.contacts.find((c) => c.id === id);
        if (existing) {
          const merged = Object.assign({ name: existing.name, role: existing.role, phone: existing.phone, address: existing.address }, values);
          Object.assign(existing, contact(id, merged.name || "Contact", merged.role || "", merged.phone || "", existing.avatar), { address: merged.address || "" });
        }
      }
    } else if (table === "care_items") {
      const found = action === "insert" ? null : findItem(id);
      const category = action === "insert" ? values.category : found && found.category;
      if (!category) return { error: new Error("That item is no longer here. Reload the page.") };
      let list;
      if (PER_CHILD.includes(category)) {
        // A save with no child goes to the first child, as the database's default-child trigger does.
        const owner = found ? found.child : childById(values.child_id) || data.children[0];
        if (!owner) return { error: new Error("Add a child first.") };
        list = owner[category];
      } else {
        list = category === "emergency" ? data.categories.emergency.steps : data.categories[category].items;
      }
      const index = list.findIndex((item) => item.id === id);
      if (action === "delete") {
        if (index >= 0) list.splice(index, 1);
      } else {
        const itemId = index >= 0 ? id : (createdId = newId(category));
        const item =
          category === "food"
            ? allergy(itemId, values.title, values.severity || "", values.detail || "", index >= 0 ? list[index].image : null)
            : { id: itemId, title: values.title, detail: values.detail || "" };
        if (index >= 0) list.splice(index, 1, item);
        else list.push(item);
      }
    } else {
      return { error: new Error("This can't be changed in the demo.") };
    }
    derive(data);
    return { error: save(), id: createdId || id };
  }

  // Which list holds a care item: a child's own, or a family-wide category.
  function findItem(id) {
    const data = window.CareNestData;
    for (const child of data.children) {
      const category = PER_CHILD.find((key) => child[key].some((item) => item.id === id));
      if (category) return { category, child };
    }
    if (data.categories.emergency.steps.some((step) => step.id === id)) return { category: "emergency" };
    if (data.categories.where.items.some((item) => item.id === id)) return { category: "where" };
    return null;
  }

  // Just enough of the Supabase client's query builder for the parent editors:
  // from(table).insert(values) / .update(values).eq(column, value) / .delete().eq("id", id).
  const client = {
    from(table) {
      let action = null;
      let values = null;
      const scope = {};
      const builder = {
        insert(v) { action = "insert"; values = v; return builder; },
        update(v) { action = "update"; values = v; return builder; },
        delete() { action = "delete"; return builder; },
        eq(column, value) { scope[column] = value; return builder; },
        select() { return builder; },
        single() { return builder; },
        then(resolve, reject) {
          let result;
          try {
            result = applyWrite(table, action, values, scope);
          } catch (e) {
            result = { error: e };
          }
          const row = { id: result.id };
          return Promise.resolve({ data: result.error ? null : Object.assign([row], row), error: result.error || null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  // The care log, check-offs, and messages this tab starts with (js/store.js reads it once).
  function shiftSeed() {
    const seed = window.CareNestData.shiftSeed;
    if (!seed) return null;
    const now = Date.now();
    const at = (minutesAgo) => now - minutesAgo * MINUTE;
    const shiftId = newId("shift");
    const completions = {};
    const messages = [];
    seed.completions.forEach((c) => {
      completions[c.taskId] = { taskId: c.taskId, photoDataUrl: null, note: c.note || "", tag: "", sentAt: at(c.minutesAgo), sender: "sitter" };
    });
    seed.messages.forEach((m) => {
      messages.push({ id: newId("msg"), kind: "chat", body: m.body, sender: m.sender, sentAt: at(m.minutesAgo) });
    });
    messages.sort((a, b) => a.sentAt - b.sentAt);
    return {
      completions,
      messages,
      // The photo prompt ("moment") is due a few minutes after the tester opens the page.
      shift: { id: shiftId, startedAt: at(seed.startedMinutesAgo), endedAt: null, momentAt: now + (2 + Math.floor(Math.random() * 3)) * MINUTE, events: [] },
      reads: {},
      saves: {},
      insights: {},
      logs: seed.logs.map((l) => ({
        id: newId("log"),
        shiftId,
        taskId: l.taskId,
        category: l.category,
        note: l.note || "",
        mealAmount: l.mealAmount || null,
        bottleOz: l.bottleOz == null ? null : l.bottleOz,
        author: l.author === "parent" ? "parent" : "sitter",
        createdAt: at(l.minutesAgo),
      })),
    };
  }

  const SITTER_PROFILE_KEY = "carenest:demo:sitter-profile";
  const SITTER_PROFILE = {
    name: "Bethany",
    bio: "Education student at the University of Michigan. CPR and first aid certified, with four years of babysitting experience with toddlers and school-age kids.",
    phone: "734 - 555 - 0110",
    availability: "Weekday afternoons and most weekends",
    showBio: true,
    showPhone: false,
    showAvailability: true,
    updates: true,
  };

  window.CareNestDemo = {
    familyId,
    familyName: window.CareNestData.familyName,
    // The babysitter's family spaces, in the shape js/auth.js's family switcher reads.
    memberships: FAMILY_IDS.map((id) => ({ household_id: id, role: "caretaker", households: { name: FAMILIES[id]().familyName } })),
    switchTo(id) {
      if (!FAMILY_IDS.includes(id)) return;
      try {
        sessionStorage.setItem(FAMILY_KEY, id);
      } catch (e) {
        /* storage unavailable: stays on this family */
      }
    },
    storeKey: `carenest:demo:v1:${familyId}`,
    shiftSeed,
    save,
    client,
    loadSitterProfile() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(SITTER_PROFILE_KEY) || "null");
        if (saved && typeof saved === "object") return Object.assign({}, SITTER_PROFILE, saved);
      } catch (e) {
        /* unreadable: the sample profile */
      }
      return Object.assign({}, SITTER_PROFILE);
    },
    saveSitterProfile(profile) {
      try {
        sessionStorage.setItem(SITTER_PROFILE_KEY, JSON.stringify(profile));
        return null;
      } catch (e) {
        return new Error("This browser tab is out of storage space, so this wasn't saved.");
      }
    },
  };
})();
