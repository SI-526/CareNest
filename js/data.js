window.CareNestData = {
  babysitter: {
    name: "Bethany",
    avatar: "assets/bethany.png",
    address: "51900 Beck St., Grand Rapids, MI, 48091",
  },

  child: {
    name: "Jack Thomas",
    age: "Age 3",
    avatar: "assets/avatar.png",
    dateLabel: "Mon, Oct 5",
    shiftTime: "3:00pm - 7:00pm",
  },

  contacts: [
    {
      id: "mary",
      name: "Mary Ann Thomas",
      firstName: "Mary",
      phone: "588 - 909 - 3489",
      phoneHref: "tel:5889093489",
      avatar: "assets/mary.png",
    },
  ],

  schedule: [
    {
      id: "snack",
      time: "1:30pm",
      title: "Snack",
      detail: "Apples and cheese",
      location: null,
      map: null,
      careNote: null,
      completed: false,
    },
    {
      id: "playground",
      time: "3:00pm",
      title: "Playground",
      detail: null,
      location: "3175 Gallup Park Rd, Ann Arbor, MI 48104",
      map: "assets/map.png",
      careNote: "Spend ~1 hour playing. Make sure to pack snacks and drinks!",
      completed: false,
    },
    {
      id: "dinner",
      time: "5:00pm",
      title: "Dinner",
      detail: "Pasta and vegetables",
      location: null,
      map: null,
      careNote: null,
      completed: false,
    },
    {
      id: "wind-down",
      time: "7:00pm",
      title: "Wind down",
      detail: "Bath time and reading",
      location: null,
      map: null,
      careNote: null,
      completed: false,
    },
  ],

  knowTiles: [
    {
      id: "food",
      label: "Food & allergies",
      icon: "assets/grocery.svg",
      href: "food-allergies.html",
    },
    {
      id: "preferences",
      label: "Preferences",
      icon: "assets/favorite.svg",
      href: "info.html?category=preferences",
    },
    {
      id: "where",
      label: "Where things are",
      icon: "assets/orders.svg",
      href: "info.html?category=where",
    },
    {
      id: "instructions",
      label: "Instructions",
      icon: "assets/assignment.svg",
      href: "info.html?category=instructions",
    },
  ],

  categories: {
    preferences: {
      title: "Preferences",
      items: [
        {
          title: "Comfort item",
          detail:
            "Jack calms down with his blue stuffed elephant, Ellie. She usually lives on his bed.",
        },
        {
          title: "Favorite activities",
          detail:
            "Building with Duplo blocks, dinosaur books, and playing tag outside.",
        },
        {
          title: "Favorite foods",
          detail:
            "Apples, rice crackers, and pasta. Not a fan of broccoli, so offer peas instead.",
        },
        {
          title: "Screen time",
          detail:
            "Up to 30 minutes of PBS Kids on the living room TV. No tablets or phones.",
        },
        {
          title: "When he is upset",
          detail:
            "Offer a hug and count to five together. A quiet book on the couch usually helps.",
        },
      ],
    },
    where: {
      title: "Where things are",
      items: [
        {
          title: "EpiPen",
          detail:
            "Bathroom cabinet, middle shelf. A second one is in the front pocket of the diaper bag.",
        },
        {
          title: "First aid kit",
          detail: "Hall closet, top shelf, in the red zip bag.",
        },
        {
          title: "Snacks",
          detail:
            "Pantry, second shelf, in the bin labeled “Jack.” Everything in it is gluten-, dairy-, and nut-free.",
        },
        {
          title: "Pull-ups and wipes",
          detail: "Basket next to the dresser in Jack’s room.",
        },
        {
          title: "Spare clothes and pajamas",
          detail: "Bottom two drawers of Jack’s dresser.",
        },
        {
          title: "Stroller",
          detail: "Garage, just left of the door into the house.",
        },
      ],
    },
    instructions: {
      title: "Instructions",
      items: [
        {
          title: "Check every label",
          detail:
            "Only serve food that is gluten-, dairy-, and nut-free. When in doubt, don’t serve it.",
        },
        {
          title: "Handwashing",
          detail:
            "Wash hands before every meal and snack, and after the playground.",
        },
        {
          title: "Outside the house",
          detail:
            "Hold hands in parking lots and near the road. Put on sunscreen before the playground.",
        },
        {
          title: "Bath time",
          detail:
            "Keep the water lukewarm and never leave Jack alone in the tub, even for a moment.",
        },
        {
          title: "Bedtime",
          detail:
            "Pajamas, brush teeth, then two books. Lights out by 7:30pm with Ellie and the night light on.",
        },
        {
          title: "Updates for Mary",
          detail:
            "Send Mary a quick text after the playground and after dinner.",
        },
      ],
    },
    emergency: {
      title: "If something goes wrong",
      summary: "Emergency steps, hospital, and who to call",
      callout: {
        text: "If Jack is in danger, not breathing, or having a severe allergic reaction, call 911 first.",
        label: "Call 911",
        href: "tel:911",
      },
      steps: [
        "Stay calm and move Jack away from anything that could hurt him.",
        "Call 911 right away if he is not breathing, will not wake up, is badly hurt, or is having a severe allergic reaction.",
        "Severe allergic reaction (swelling, trouble breathing, hives): use the EpiPen from the bathroom cabinet on the outside of his thigh, then call 911.",
        "Possible poisoning: call Poison Control at 1-800-222-1222.",
        "If he needs a doctor but it is not life-threatening, drive him to the hospital below. Bring the diaper bag and his EpiPen.",
        "Call Mary as soon as Jack is safe. If you cannot reach her, call the other contacts below in order.",
      ],
      hospital: {
        name: "C.S. Mott Children’s Hospital",
        system: "Michigan Medicine, Pediatric Emergency",
        address: "1540 E Hospital Dr, Ann Arbor, MI 48109",
        mapHref:
          "https://www.google.com/maps/search/?api=1&query=1540+E+Hospital+Dr%2C+Ann+Arbor%2C+MI+48109",
        phone: "734 - 555 - 0100",
        phoneHref: "tel:7345550100",
      },
      contacts: [
        { contactId: "mary", role: "Parent" },
        {
          name: "David Thomas",
          role: "Parent",
          phone: "734 - 555 - 0142",
          phoneHref: "tel:7345550142",
        },
        {
          name: "Linda Thomas",
          role: "Grandmother",
          phone: "616 - 555 - 0187",
          phoneHref: "tel:6165550187",
        },
        {
          name: "Dr. Priya Shah",
          role: "Pediatrician",
          phone: "734 - 555 - 0123",
          phoneHref: "tel:7345550123",
        },
      ],
    },
  },

  allergies: {
    title: "Food & allergies",
    sectionTitle: "Dietary restrictions",
    careNote:
      "Epinephrine auto-injector (EpiPen) available in bathroom cabinet for use in the event of a severe allergic reaction.",
    items: [
      {
        name: "Gluten-free",
        severity: "Severe",
        severityClass: "badge--severe",
        image: "assets/gluten.png",
        description:
          "Avoid wheat, barley, and rye. Use separate utensils; check food labels.",
      },
      {
        name: "Dairy-free",
        severity: "Mild",
        severityClass: "badge--mild",
        image: "assets/dairy.png",
        description:
          "Avoid milk, cheese, and butter. Serve dairy-free alternatives.",
      },
      {
        name: "Nut-free",
        severity: "Severe",
        severityClass: "badge--severe",
        image: "assets/nuts.png",
        description:
          "Avoid nuts and nut traces. Follow the child’s allergy care plan.",
      },
    ],
  },
};
