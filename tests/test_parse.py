from docintake.parse import day, money, norm_name, norm_number, similarity


def test_money_formats():
    assert money("$1,234.50") == 123450 and money("1.234,50") == 123450 and money("7,760.00") == 776000
    assert money("(45.00)") == -4500 and money("-45.00") == -4500 and money("12") == 1200 and money("abc") is None


def test_dates():
    assert day("11/03/2026") == "2026-11-03" and day("03.11.2026") == "2026-11-03"
    assert day("Nov 3, 2026") == "2026-11-03" and day("2026-11-03") == "2026-11-03"
    assert day("13/45/2026") is None and day("soon") is None


def test_numbers_and_names():
    assert norm_number("CP 077120") == norm_number("CP-77120")
    assert norm_number("BH-20418") != norm_number("BH-20419")
    assert norm_name("Ostrava Roastery Equipment s.r.o.") == "ostrava roastery equipment"
    assert similarity("meridlan it services", "meridian it services") > 0.9
