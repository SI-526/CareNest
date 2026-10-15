-- LOCAL DEVELOPMENT ONLY. Loaded by `supabase db reset` against the local stack.
-- Never run against a hosted project (`supabase db push` does not run seeds by default).
--
-- The demo family from js/data.js (Jack Thomas), as one household with no members. Users cannot
-- be created from SQL, so after signing up locally attach yourself to it (see README,
-- "Local database"):
--
--   insert into public.household_members (household_id, user_id, role, email, display_name)
--   select '00000000-0000-4000-8000-00000000c0de', id, 'parent', lower(email), 'Mary'
--   from auth.users where email = 'you@example.test';

insert into public.households (id, name, child_name, child_age_label, risk_acknowledged_at)
values ('00000000-0000-4000-8000-00000000c0de', 'Thomas family', 'Jack Thomas', 'Age 3', now());

insert into public.plans (id, household_id, title, schedule)
values (
  '00000000-0000-4000-8000-00000000d00d',
  '00000000-0000-4000-8000-00000000c0de',
  'Weekday afternoon',
  '3:00pm - 7:00pm'
);

insert into public.tasks (plan_id, position, time_of_day, title, detail, location, care_note)
values
  ('00000000-0000-4000-8000-00000000d00d', 0, '13:30', 'Snack', 'Apples and cheese', '', ''),
  ('00000000-0000-4000-8000-00000000d00d', 1, '15:00', 'Playground', '',
   '3175 Gallup Park Rd, Ann Arbor, MI 48104',
   'Spend ~1 hour playing. Make sure to pack snacks and drinks!'),
  ('00000000-0000-4000-8000-00000000d00d', 2, '17:00', 'Dinner', 'Pasta and vegetables', '', ''),
  ('00000000-0000-4000-8000-00000000d00d', 3, '19:00', 'Wind down', 'Bath time and reading', '', '');

insert into public.contacts (household_id, position, name, role, phone, address)
values
  ('00000000-0000-4000-8000-00000000c0de', 0, 'Mary Ann Thomas', 'Parent', '588-909-3489', ''),
  ('00000000-0000-4000-8000-00000000c0de', 1, 'David Thomas', 'Parent', '734-555-0142', ''),
  ('00000000-0000-4000-8000-00000000c0de', 2, 'Linda Thomas', 'Grandmother', '616-555-0187', ''),
  ('00000000-0000-4000-8000-00000000c0de', 3, 'Dr. Priya Shah', 'Pediatrician', '734-555-0123', ''),
  ('00000000-0000-4000-8000-00000000c0de', 4, 'C.S. Mott Children’s Hospital', 'Hospital',
   '734-555-0100', '1540 E Hospital Dr, Ann Arbor, MI 48109');

insert into public.care_items (household_id, category, position, title, detail, severity)
values
  ('00000000-0000-4000-8000-00000000c0de', 'preferences', 0, 'Comfort item',
   'Jack calms down with his blue stuffed elephant, Ellie. She usually lives on his bed.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'preferences', 1, 'Favorite activities',
   'Building with Duplo blocks, dinosaur books, and playing tag outside.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'preferences', 2, 'Favorite foods',
   'Apples, rice crackers, and pasta. Not a fan of broccoli, so offer peas instead.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'preferences', 3, 'Screen time',
   'Up to 30 minutes of PBS Kids on the living room TV. No tablets or phones.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'preferences', 4, 'When he is upset',
   'Offer a hug and count to five together. A quiet book on the couch usually helps.', null),

  ('00000000-0000-4000-8000-00000000c0de', 'where', 0, 'EpiPen',
   'Bathroom cabinet, middle shelf. A second one is in the front pocket of the diaper bag.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'where', 1, 'First aid kit',
   'Hall closet, top shelf, in the red zip bag.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'where', 2, 'Snacks',
   'Pantry, second shelf, in the bin labeled “Jack.” Everything in it is gluten-, dairy-, and nut-free.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'where', 3, 'Pull-ups and wipes',
   'Basket next to the dresser in Jack’s room.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'where', 4, 'Spare clothes and pajamas',
   'Bottom two drawers of Jack’s dresser.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'where', 5, 'Stroller',
   'Garage, just left of the door into the house.', null),

  ('00000000-0000-4000-8000-00000000c0de', 'instructions', 0, 'Check every label',
   'Only serve food that is gluten-, dairy-, and nut-free. When in doubt, don’t serve it.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'instructions', 1, 'Handwashing',
   'Wash hands before every meal and snack, and after the playground.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'instructions', 2, 'Outside the house',
   'Hold hands in parking lots and near the road. Put on sunscreen before the playground.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'instructions', 3, 'Bath time',
   'Keep the water lukewarm and never leave Jack alone in the tub, even for a moment.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'instructions', 4, 'Bedtime',
   'Pajamas, brush teeth, then two books. Lights out by 7:30pm with Ellie and the night light on.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'instructions', 5, 'Updates for Mary',
   'Send Mary a quick text after the playground and after dinner.', null),

  ('00000000-0000-4000-8000-00000000c0de', 'emergency', 0, 'Stay calm',
   'Stay calm and move Jack away from anything that could hurt him.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'emergency', 1, 'Call 911',
   'Call 911 right away if he is not breathing, will not wake up, is badly hurt, or is having a severe allergic reaction.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'emergency', 2, 'Severe allergic reaction',
   'Severe allergic reaction (swelling, trouble breathing, hives): use the EpiPen from the bathroom cabinet on the outside of his thigh, then call 911.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'emergency', 3, 'Possible poisoning',
   'Possible poisoning: call Poison Control at 1-800-222-1222.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'emergency', 4, 'Needs a doctor',
   'If he needs a doctor but it is not life-threatening, drive him to the hospital below. Bring the diaper bag and his EpiPen.', null),
  ('00000000-0000-4000-8000-00000000c0de', 'emergency', 5, 'Call Mary',
   'Call Mary as soon as Jack is safe. If you cannot reach her, call the other contacts below in order.', null),

  ('00000000-0000-4000-8000-00000000c0de', 'food', 0, 'Gluten-free',
   'Avoid wheat, barley, and rye. Use separate utensils; check food labels.', 'Severe'),
  ('00000000-0000-4000-8000-00000000c0de', 'food', 1, 'Dairy-free',
   'Avoid milk, cheese, and butter. Serve dairy-free alternatives.', 'Mild'),
  ('00000000-0000-4000-8000-00000000c0de', 'food', 2, 'Nut-free',
   'Avoid nuts and nut traces. Follow the child’s allergy care plan.', 'Severe'),
  ('00000000-0000-4000-8000-00000000c0de', 'food', 3, 'Care note',
   'Epinephrine auto-injector (EpiPen) available in bathroom cabinet for use in the event of a severe allergic reaction.', null);
